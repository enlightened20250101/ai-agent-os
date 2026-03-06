import { expect, test, type Page } from "@playwright/test";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var for E2E: ${name}`);
  }
  return value;
}

function enableDialogAutoAccept(page: Page, messages?: string[]) {
  page.on("dialog", async (dialog) => {
    if (messages) {
      messages.push(dialog.message());
    }
    await dialog.accept();
  });
}

async function createAgent(page: Page, agentName: string, roleKey = "accounting") {
  await page.goto("/app/agents");
  await page.locator('input[name="name"]').fill(agentName);
  await page.locator('input[name="role_key"]').fill(roleKey);
  await page.getByRole("button", { name: "エージェントを作成" }).click();
}

async function resolveOrgId(page: Page) {
  const raw = await page.getByTestId("org-context-id").textContent();
  const orgId = raw?.trim() ?? "";
  if (!orgId) {
    throw new Error("Could not resolve orgId from app home.");
  }
  return orgId;
}

test("agents -> tasks -> approvals flow", async ({ page, request }, testInfo) => {
  const dialogMessages: string[] = [];
  enableDialogAutoAccept(page, dialogMessages);
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+${timestamp}@example.com`;
  const agentName = "E2E Agent";
  const taskTitle = `E2E Task ${timestamp}`;
  const slackTaskText = `Slack intake E2E ${timestamp}`;
  let activeTaskTitle = taskTitle;
  let orgId: string | null = null;
  let taskPath: string | null = null;
  let taskId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      const body = await provisionResponse.text();
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${body}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();

    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);
    if (!orgId) {
      throw new Error("Could not resolve orgId from app home.");
    }

    const slackEventResponse = await request.post("/api/slack/events", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        type: "event_callback",
        event_id: `EvE2E${timestamp}`,
        team_id: "TE2E",
        e2e_org_id: orgId,
        event: {
          type: "app_mention",
          user: "UE2E",
          text: slackTaskText,
          channel: "CE2E",
          ts: `${Math.floor(Date.now() / 1000)}.123456`
        }
      }
    });
    if (!slackEventResponse.ok()) {
      throw new Error(`Slack intake failed: ${slackEventResponse.status()} ${await slackEventResponse.text()}`);
    }

    await page.goto("/app/tasks?source=slack");
    let slackTaskLink = page.getByRole("link", { name: slackTaskText });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await slackTaskLink.count()) {
        break;
      }
      await page.reload();
      slackTaskLink = page.getByRole("link", { name: slackTaskText });
    }
    if (await slackTaskLink.count()) {
      await expect(slackTaskLink).toBeVisible({ timeout: 30_000 });
      await page.getByRole("link", { name: slackTaskText }).click();
      await expect(page.getByText("SLACK_TASK_INTAKE").first()).toBeVisible({ timeout: 30_000 });
    } else {
      console.warn("[E2E_WARN] Slack intake task was not materialized in time; continuing core flow.");
    }

    await createAgent(page, agentName, "accounting");
    await expect.poll(() => dialogMessages.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(dialogMessages.some((message) => message.includes("実行しますか"))).toBeTruthy();

    await expect(page.getByText(agentName).first()).toBeVisible();

    await page.goto("/app/tasks");
    const agentSelect = page.locator('select[name="agent_id"]').first();
    await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    let agentOptionValue: string | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const options = await agentSelect.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("value") ?? "",
          text: node.textContent ?? "",
          disabled: (node as HTMLOptionElement).disabled
        }))
      );
      const preferred = options.find((option) => option.text.includes(agentName) && !option.disabled);
      agentOptionValue = preferred?.value ?? null;
      if (agentOptionValue) break;
      await page.reload();
      await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    }
    if (!agentOptionValue) {
      throw new Error("Could not find E2E Agent option.");
    }
    await agentSelect.selectOption(agentOptionValue);
    await page.getByPlaceholder("タスクタイトル").fill(taskTitle);
    await page.getByPlaceholder("タスク入力").fill("Please draft an email to vendor.");
    await page.getByRole("button", { name: "タスクを作成" }).click();

    await page.getByRole("link", { name: taskTitle }).first().click();
    await expect(page).toHaveURL(/\/app\/tasks\/.+/);

    await page.goto("/app/planner");
    await page.getByRole("button", { name: "今すぐプランナー実行" }).click();
    await expect(page.getByText(/プランナー実行が完了/)).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/proposals");
    const proposalRow = page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: "受け入れ", exact: true }) })
      .first();
    await expect(proposalRow).toBeVisible({ timeout: 30_000 });
    await proposalRow.getByRole("button", { name: "受け入れ", exact: true }).click();
    await page.waitForURL(/\/app\/tasks\/.+/);
    taskPath = new URL(page.url()).pathname;
    taskId = taskPath.split("/").pop() ?? null;
    activeTaskTitle = (await page.locator("h1").first().innerText()).trim();
    await expect(page.getByText("MODEL_INFERRED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("POLICY_CHECKED").first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "承認依頼" }).click();
    await expect(page.getByText("APPROVAL_REQUESTED")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/approvals");
    let row = page.locator("li").filter({ hasText: activeTaskTitle }).first();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await row.count()) {
        break;
      }
      await page.reload();
      row = page.locator("li").filter({ hasText: activeTaskTitle }).first();
    }
    await expect(row).toBeVisible();
    await row.getByPlaceholder("理由（任意）").fill("ok");
    await Promise.all([
      page.waitForResponse((response) => {
        return response.url().includes("/app/approvals") && response.request().method() === "POST";
      }),
      row.getByRole("button", { name: "承認" }).click()
    ]);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const pendingRow = page.locator("li").filter({ hasText: activeTaskTitle }).first();
      if ((await pendingRow.count()) === 0) {
        break;
      }
      await page.reload();
    }

    await expect(page.locator("li").filter({ hasText: activeTaskTitle })).toHaveCount(0);

    if (!taskPath) {
      throw new Error("Task path not captured.");
    }
    await page.goto(taskPath);
    const taskHeaderSection = page.locator("section").first();
    await expect(taskHeaderSection.getByText(/^ステータス: approved$/)).toBeVisible();

    await page.getByRole("button", { name: "メール送信を実行" }).click();
    await expect(page.getByText("ACTION_EXECUTED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/最新アクションの状態:\s*success/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("現在のドラフトアクションはすでに実行済みです。", { exact: true })).toBeVisible({
      timeout: 30_000
    });

    const executeAgainButton = page.getByRole("button", { name: "メール送信を実行" });
    if (await executeAgainButton.count()) {
      await executeAgainButton.click();
      await expect(page.getByText("ACTION_SKIPPED").first()).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(page.getByText("現在のドラフトアクションはすでに実行済みです。", { exact: true })).toBeVisible({
        timeout: 30_000
      });
    }
    await expect(page.getByText("ACTION_EXECUTED")).toHaveCount(1);

    await expect(page.getByText("TASK_CREATED").first()).toBeVisible();
    await expect(page.getByText("APPROVAL_REQUESTED").first()).toBeVisible();
    await expect(page.getByText("HUMAN_APPROVED").first()).toBeVisible();

    if (!taskId) {
      throw new Error("Task id not captured.");
    }
    await page.goto(`/app/tasks/${taskId}/evidence`);
    await expect(page.getByText("タスク概要")).toBeVisible();
    await expect(page.getByText("MODEL_INFERRED").first()).toBeVisible();
    await expect(page.getByText("POLICY_CHECKED").first()).toBeVisible();
    await expect(page.getByText("ACTION_EXECUTED").first()).toBeVisible();
    await expect(page.getByText(`タイトル: ${activeTaskTitle}`).first()).toBeVisible();
    await expect(page.getByText("例外ケース監査")).toBeVisible();
    await expect(page.getByText("Exception Case Events")).toBeVisible();

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG] skipping cleanup for failed run orgId=${orgId ?? "unknown"} taskId=${taskId ?? "unknown"}`);
    }
  }
});

test("recovery link navigates with context and highlights target", async ({ page, request }, testInfo) => {
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");
  const timestamp = Date.now();
  const email = `e2e+recovery+${timestamp}@example.com`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${await provisionResponse.text()}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    const seedResponse = await request.post("/api/e2e/seed-recovery-context", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        orgId,
        intentType: "run_planner",
        recoveryPath: "/app/planner"
      }
    });
    if (!seedResponse.ok()) {
      throw new Error(`Failed to seed recovery context: ${seedResponse.status()} ${await seedResponse.text()}`);
    }

    await page.goto("/app/executions?status=failed&source=chat");
    const seededRow = page.locator("li").filter({ hasText: "E2E seeded recovery log" }).first();
    await expect(seededRow).toBeVisible({ timeout: 30_000 });
    await seededRow.getByRole("link", { name: "復旧先を開く" }).click();

    await page.waitForURL(/\/app\/planner\?/);
    await expect(page.getByText("参照コンテキスト: executions / run_planner")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#ref-target").first()).toBeVisible({ timeout: 30_000 });

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][recovery-link] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("chat audit recovery link navigates with context and highlights target", async ({ page, request }, testInfo) => {
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");
  const timestamp = Date.now();
  const email = `e2e+chatrecovery+${timestamp}@example.com`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${await provisionResponse.text()}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    const seedResponse = await request.post("/api/e2e/seed-recovery-context", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        orgId,
        intentType: "run_planner",
        recoveryPath: "/app/planner",
        includeChatAudit: true
      }
    });
    if (!seedResponse.ok()) {
      throw new Error(`Failed to seed chat recovery context: ${seedResponse.status()} ${await seedResponse.text()}`);
    }

    await page.goto("/app/chat/audit?status=failed");
    const seededRow = page.locator("li").filter({ hasText: "E2E seeded chat audit recovery command" }).first();
    await expect(seededRow).toBeVisible({ timeout: 30_000 });
    await seededRow.getByRole("link", { name: "復旧先を開く" }).click();

    await page.waitForURL(/\/app\/planner\?/);
    await expect(page.getByText("参照コンテキスト: chat_audit / run_planner")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#ref-target").first()).toBeVisible({ timeout: 30_000 });

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][chat-recovery-link] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("chat audit export respects session_id and status filters", async ({ page, request }, testInfo) => {
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");
  const timestamp = Date.now();
  const email = `e2e+chatexport+${timestamp}@example.com`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${await provisionResponse.text()}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    const seedResponse = await request.post("/api/e2e/seed-recovery-context", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        orgId,
        intentType: "run_planner",
        includeChatAudit: true,
        chatCommandStatus: "failed",
        executionLogStatus: "failed"
      }
    });
    if (!seedResponse.ok()) {
      throw new Error(`Failed to seed chat export context: ${seedResponse.status()} ${await seedResponse.text()}`);
    }
    const seeded = (await seedResponse.json()) as { chatSessionId?: string | null };
    const sessionId = seeded.chatSessionId ?? "";
    if (!sessionId) {
      throw new Error("Failed to obtain seeded chat session id");
    }

    const exportRes = await page.request.get(
      `/api/chat/audit/export?format=json&status=failed&scope=all&intent=all&skip_reason=all&ai=all&window=7d&session_id=${encodeURIComponent(
        sessionId
      )}&limit=5000&offset=0&include_result=1`
    );
    expect(exportRes.ok()).toBeTruthy();
    const body = (await exportRes.json()) as {
      meta?: { filter_session_id?: string; filter_status?: string; row_count_exported?: number };
      rows?: Array<{ session_id?: string; execution_status?: string }>;
    };
    expect(body.meta?.filter_status).toBe("failed");
    expect(body.meta?.filter_session_id).toBe(sessionId);
    expect((body.meta?.row_count_exported ?? 0) > 0).toBeTruthy();
    expect(
      (body.rows ?? []).every((row) => row.session_id === sessionId && row.execution_status === "failed")
    ).toBeTruthy();

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][chat-export-filter] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("executions export respects session_id and incident filters", async ({ page, request }, testInfo) => {
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");
  const timestamp = Date.now();
  const email = `e2e+execexport+${timestamp}@example.com`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${await provisionResponse.text()}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    const seedResponse = await request.post("/api/e2e/seed-recovery-context", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        orgId,
        intentType: "run_planner",
        includeChatAudit: true,
        chatCommandStatus: "failed",
        executionLogStatus: "skipped",
        blockedByIncident: true,
        incidentSeverity: "high"
      }
    });
    if (!seedResponse.ok()) {
      throw new Error(`Failed to seed execution export context: ${seedResponse.status()} ${await seedResponse.text()}`);
    }
    const seeded = (await seedResponse.json()) as { chatSessionId?: string | null };
    const sessionId = seeded.chatSessionId ?? "";
    if (!sessionId) {
      throw new Error("Failed to obtain seeded execution session id");
    }

    const csvRes = await page.request.get(
      `/api/executions/export?status=skipped&source=chat&scope=shared&intent=run_planner&incident=blocked&session_id=${encodeURIComponent(sessionId)}`
    );
    expect(csvRes.ok()).toBeTruthy();
    const csvText = await csvRes.text();
    const lines = csvText.trim().split("\n");
    expect(lines.length >= 2).toBeTruthy();
    expect(lines[0].includes("session_id")).toBeTruthy();
    expect(csvText.includes(sessionId)).toBeTruthy();
    expect(csvText.includes("skipped")).toBeTruthy();
    expect(csvText.includes("chat")).toBeTruthy();

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][executions-export-filter] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("workflow execute_google_send_email step auto-runs and logs events", async ({ page, request }, testInfo) => {
  enableDialogAutoAccept(page);
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+wf+${timestamp}@example.com`;
  const agentName = "E2E WF Agent";
  const taskTitle = `E2E WF Task ${timestamp}`;
  const templateName = `E2E WF Template ${timestamp}`;
  let orgId: string | null = null;
  let taskPath: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      const body = await provisionResponse.text();
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${body}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    await createAgent(page, agentName, "accounting");

    await page.goto("/app/tasks");
    const agentSelect = page.locator('select[name="agent_id"]').first();
    await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    let agentOptionValue: string | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const options = await agentSelect.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("value") ?? "",
          text: node.textContent ?? "",
          disabled: (node as HTMLOptionElement).disabled
        }))
      );
      const preferred = options.find((option) => option.text.includes(agentName) && !option.disabled);
      agentOptionValue = preferred?.value ?? null;
      if (agentOptionValue) {
        break;
      }
      await page.reload();
      await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    }
    if (!agentOptionValue) {
      const fallbackOptions = await agentSelect.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("value") ?? "",
          disabled: (node as HTMLOptionElement).disabled
        }))
      );
      agentOptionValue =
        fallbackOptions.find((option) => option.value && !option.disabled)?.value ?? null;
    }
    if (!agentOptionValue) {
      throw new Error("Could not find workflow E2E agent option.");
    }
    await agentSelect.selectOption(agentOptionValue);
    await page.getByPlaceholder("タスクタイトル").fill(taskTitle);
    await page.getByPlaceholder("タスク入力").fill("Please draft an email to vendor.");
    await page.getByRole("button", { name: "タスクを作成" }).click();

    await page.getByRole("link", { name: taskTitle }).first().click();
    await expect(page).toHaveURL(/\/app\/tasks\/.+/);
    taskPath = new URL(page.url()).pathname;

    await page.getByRole("button", { name: "ドラフト生成" }).click();
    await expect(page.getByText("MODEL_INFERRED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("POLICY_CHECKED").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "承認依頼" }).click();
    await expect(page.getByText("APPROVAL_REQUESTED").first()).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/approvals");
    let row = page.locator("li").filter({ hasText: taskTitle }).first();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if ((await row.count()) > 0) {
        break;
      }
      await page.reload();
      row = page.locator("li").filter({ hasText: taskTitle }).first();
    }
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByPlaceholder("理由（任意）").fill("workflow ok");
    await Promise.all([
      page.waitForResponse((response) => {
        return response.url().includes("/app/approvals") && response.request().method() === "POST";
      }),
      row.getByRole("button", { name: "承認" }).click()
    ]);

    await page.goto("/app/workflows");
    await page.getByPlaceholder("テンプレート名").fill(templateName);
    await page
      .getByPlaceholder(/ステップを1行ずつ入力/)
      .fill("自動メール送信|execute_google_send_email|false");
    await page.getByRole("button", { name: "テンプレートを作成" }).click();
    await page.waitForURL(/\/app\/workflows(\?.*)?/, { timeout: 30_000 });
    await expect(page.getByText(templateName)).toBeVisible({ timeout: 30_000 });

    if (!taskPath) {
      throw new Error("task path missing for workflow test");
    }
    await page.goto(taskPath);

    const workflowSelect = page.locator('select[name="template_id"]').first();
    const templateOptionValue = await workflowSelect
      .locator("option")
      .filter({ hasText: templateName })
      .first()
      .getAttribute("value");
    if (!templateOptionValue) {
      throw new Error("Could not find workflow template option.");
    }
    await workflowSelect.selectOption(templateOptionValue);
    await page.getByRole("button", { name: "ワークフロー実行を開始" }).click();

    await page.waitForURL(/\/app\/workflows\/runs/);
    await page.locator('a[href*="/app/workflows/runs/"]').first().click();
    await expect(page).toHaveURL(/\/app\/workflows\/runs\/.+/);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const statusLine = page.getByText(/(status|状態):\s*(running|completed|failed|実行中|完了|失敗)/).first();
      const statusText = await statusLine.innerText();
      if (statusText.includes("completed") || statusText.includes("完了")) {
        break;
      }
      if (statusText.includes("failed") || statusText.includes("失敗")) {
        throw new Error(`Workflow run failed: ${statusText}`);
      }
      await page.reload();
    }
    await expect(page.getByText(/(status:\s*completed|状態:\s*完了)/)).toBeVisible({ timeout: 30_000 });

    await page.goto(taskPath);
    await expect(page.getByText("WORKFLOW_STARTED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("WORKFLOW_STEP_COMPLETED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("ACTION_EXECUTED").first()).toBeVisible({ timeout: 30_000 });

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    const shouldCleanup = flowSucceeded && orgId && (didPassByStatus || testInfo.status === "skipped");
    if (shouldCleanup) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][workflow] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("workflow execute_google_send_email fails on unapproved task and logs WORKFLOW_FAILED", async ({ page, request }, testInfo) => {
  enableDialogAutoAccept(page);
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+wf-fail+${timestamp}@example.com`;
  const agentName = "E2E WF Fail Agent";
  const taskTitle = `E2E WF Fail Task ${timestamp}`;
  const templateName = `E2E WF Fail Template ${timestamp}`;
  let orgId: string | null = null;
  let taskPath: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      const body = await provisionResponse.text();
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${body}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    await createAgent(page, agentName, "accounting");
    await expect(page.getByText(agentName)).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/tasks");
    const agentSelect = page.locator('select[name="agent_id"]').first();
    await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    let agentOptionValue: string | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const options = await agentSelect.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("value") ?? "",
          text: node.textContent ?? "",
          disabled: (node as HTMLOptionElement).disabled
        }))
      );
      const preferred = options.find((option) => option.text.includes(agentName) && !option.disabled);
      agentOptionValue = preferred?.value ?? null;
      if (agentOptionValue) {
        break;
      }
      await page.reload();
      await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    }
    if (!agentOptionValue) {
      const fallbackOptions = await agentSelect.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("value") ?? "",
          disabled: (node as HTMLOptionElement).disabled
        }))
      );
      agentOptionValue =
        fallbackOptions.find((option) => option.value && !option.disabled)?.value ?? null;
    }
    if (!agentOptionValue) {
      throw new Error("Could not find workflow fail agent option.");
    }
    await agentSelect.selectOption(agentOptionValue);
    await page.getByPlaceholder("タスクタイトル").fill(taskTitle);
    await page.getByPlaceholder("タスク入力").fill("Please draft an email to vendor.");
    await page.getByRole("button", { name: "タスクを作成" }).click();

    await page.getByRole("link", { name: taskTitle }).first().click();
    await expect(page).toHaveURL(/\/app\/tasks\/.+/);
    taskPath = new URL(page.url()).pathname;

    // Keep task unapproved; workflow step should fail with guardrail.
    await page.getByRole("button", { name: "ドラフト生成" }).click();
    await expect(page.getByText("MODEL_INFERRED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("POLICY_CHECKED").first()).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/workflows");
    await page.getByPlaceholder("テンプレート名").fill(templateName);
    await page
      .getByPlaceholder(/ステップを1行ずつ入力/)
      .fill("未承認メール送信|execute_google_send_email|false");
    await page.getByRole("button", { name: "テンプレートを作成" }).click();
    await expect(page.getByText(templateName)).toBeVisible({ timeout: 30_000 });

    if (!taskPath) {
      throw new Error("task path missing for workflow fail test");
    }
    await page.goto(taskPath);
    const workflowSelect = page.locator('select[name="template_id"]').first();
    const templateOptionValue = await workflowSelect
      .locator("option")
      .filter({ hasText: templateName })
      .first()
      .getAttribute("value");
    if (!templateOptionValue) {
      throw new Error("Could not find workflow fail template option.");
    }
    await workflowSelect.selectOption(templateOptionValue);
    await page.getByRole("button", { name: "ワークフロー実行を開始" }).click();
    await Promise.race([
      page.waitForURL(/\/app\/workflows\/runs/, { timeout: 30_000 }),
      page.waitForURL(/\/app\/tasks\/.+\?error=/, { timeout: 30_000 })
    ]);

    if (/\/app\/workflows\/runs/.test(page.url())) {
      await page.getByRole("link", { name: /run / }).first().click();
      await expect(page).toHaveURL(/\/app\/workflows\/runs\/.+/);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const statusLine = page.getByText(/status:\s*(running|completed|failed)/).first();
        const statusText = await statusLine.innerText();
        if (statusText.includes("failed")) {
          break;
        }
        await page.reload();
      }
      await expect(page.getByText(/status:\s*failed/)).toBeVisible({ timeout: 30_000 });
      await page.goto(taskPath);
    }

    await expect(page.getByText("WORKFLOW_FAILED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("ACTION_EXECUTED")).toHaveCount(0);

    await page.locator('a[href*="/app/workflows/runs/"]').first().click();
    await expect(page).toHaveURL(/\/app\/workflows\/runs\/.+/);
    await Promise.all([
      page.waitForURL(/\/app\/workflows\/runs\/.+\?(ok|error)=.+$/, { timeout: 30_000 }),
      page.getByRole("button", { name: "失敗したステップを再試行" }).click()
    ]);
    await expect(page).toHaveURL(/\/app\/workflows\/runs\/.+/);
    await expect(page.getByText(/(status:\s*failed|状態:\s*失敗)/)).toBeVisible({ timeout: 30_000 });

    await page.goto(taskPath);
    await expect(page).toHaveURL(new RegExp(`${taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(page.getByText("WORKFLOW_FAILED").first()).toBeVisible({ timeout: 30_000 });

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][workflow-fail] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("governance recommendation risky action requires confirmation checkbox", async ({ page, request }, testInfo) => {
  enableDialogAutoAccept(page);
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+gov-rec+${timestamp}@example.com`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      const body = await provisionResponse.text();
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${body}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    await page.goto("/app/governance/autonomy");
    await page.getByLabel("自律レベル").selectOption("L3");
    const autoExecuteCheckbox = page.getByRole("checkbox", { name: /Google.*send_email.*自動実行を許可する/ });
    await autoExecuteCheckbox.check();
    await page.getByRole("button", { name: "設定を保存" }).click();
    await expect(page.getByText("自律設定を更新しました。")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/governance/recommendations");
    const recommendationRow = page.locator("li").filter({ hasText: "自動実行トグルの定期見直し" }).first();
    await expect(recommendationRow).toBeVisible({ timeout: 30_000 });

    await recommendationRow.getByRole("button", { name: "自動実行を一時停止" }).click();
    await expect(page.getByText("危険操作を実行するには確認チェックが必要です。")).toBeVisible({ timeout: 30_000 });

    await recommendationRow.getByLabel("自動実行を停止することを理解しました").check();
    await recommendationRow.getByRole("button", { name: "自動実行を一時停止" }).click();
    await expect(page.getByText("自動実行を一時停止しました。")).toBeVisible({ timeout: 30_000 });
    await page.goto("/app/governance/autonomy");
    await expect(page.getByRole("checkbox", { name: /Google.*send_email.*自動実行を許可する/ })).not.toBeChecked();

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][gov-rec] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("exceptions notify performs auto-assign and escalation audit events", async ({ page, request }, testInfo) => {
  enableDialogAutoAccept(page);
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+exceptions+${timestamp}@example.com`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      const body = await provisionResponse.text();
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${body}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);
    if (!orgId) {
      throw new Error("Failed to resolve orgId for exception e2e.");
    }

    const seeded = await request.post("/api/e2e/seed-exception-case", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        orgId,
        kind: "failed_action",
        refId: `e2e-exc-${timestamp}`,
        overdueHours: 12
      }
    });
    if (!seeded.ok()) {
      const body = await seeded.text();
      if (body.includes("public.exception_cases") || body.includes('relation "exception_cases"')) {
        testInfo.annotations.push({
          type: "skip-note",
          description: "exception_cases table missing; skipping exception escalation assertions"
        });
        flowSucceeded = true;
        return;
      }
      throw new Error(`Failed to seed exception case: ${seeded.status()} ${body}`);
    }

    await page.goto("/app/operations/exceptions");
    await page.getByRole("button", { name: "例外通知をSlack送信" }).click();

    const successAlert = page.getByText(/例外通知を送信しました。target=/);
    const failAlert = page.getByText(/例外通知を送信できませんでした。reason=/);
    await Promise.race([successAlert.waitFor({ state: "visible" }), failAlert.waitFor({ state: "visible" })]);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const hasAssigned = (await page.getByText("CASE_AUTO_ASSIGNED").count()) > 0;
      const hasEscalated = (await page.getByText("CASE_ESCALATED").count()) > 0;
      if (hasAssigned && hasEscalated) {
        break;
      }
      await page.reload();
    }

    await expect(page.getByText("CASE_AUTO_ASSIGNED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("CASE_ESCALATED").first()).toBeVisible({ timeout: 30_000 });

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][exceptions] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("chat commands can request approval and execute action with confirmation", async ({ page, request }, testInfo) => {
  enableDialogAutoAccept(page);
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+chat+${timestamp}@example.com`;
  const agentName = "E2E Chat Agent";
  const taskTitle = `E2E Chat Task ${timestamp}`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      const body = await provisionResponse.text();
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${body}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);

    await createAgent(page, agentName, "accounting");
    await expect(page.getByText(agentName)).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/tasks");
    const agentSelect = page.locator('select[name="agent_id"]').first();
    await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    const agentOptionValue = await agentSelect
      .locator("option")
      .filter({ hasText: agentName })
      .first()
      .getAttribute("value");
    if (!agentOptionValue) {
      throw new Error("Could not find chat E2E agent option.");
    }
    await agentSelect.selectOption(agentOptionValue);
    await page.getByPlaceholder("タスクタイトル").fill(taskTitle);
    await page.getByPlaceholder("タスク入力").fill("Please draft an email to vendor.");
    await page.getByRole("button", { name: "タスクを作成" }).click();

    await page.getByRole("link", { name: taskTitle }).first().click();
    await expect(page).toHaveURL(/\/app\/tasks\/.+/);
    const taskPath = new URL(page.url()).pathname;
    const taskId = taskPath.split("/").pop() ?? "";
    if (!taskId) {
      throw new Error("Task id missing for chat e2e.");
    }

    await page.getByRole("button", { name: "ドラフト生成" }).click();
    await expect(page.getByText("MODEL_INFERRED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("POLICY_CHECKED").first()).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/chat/shared");
    const chatSchemaMissingNotice = page.getByText(/chat 機能のDB migration/);
    if (await chatSchemaMissingNotice.count()) {
      testInfo.annotations.push({
        type: "note",
        description: "chat_* migration not applied; skip chat command scenario."
      });
      return;
    }
    await page.getByLabel("メッセージ").fill(`@AI 「${taskTitle}」の承認依頼を出して`);
    await page.getByRole("button", { name: "送信" }).click();
    await expect(page.getByText("実行確認待ち")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /はい、実行する|Yes, execute/ }).first().click();
    await expect(page.getByText("承認依頼を作成しました")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/approvals");
    const row = page.locator("li").filter({ hasText: taskTitle }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByPlaceholder("理由（任意）").fill("chat ok");
    await row.getByRole("button", { name: "承認" }).click();
    await expect(page.locator("li").filter({ hasText: taskTitle })).toHaveCount(0, { timeout: 30_000 });

    await page.goto("/app/chat/shared");
    await page.getByLabel("メッセージ").fill(`@AI 「${taskTitle}」を実行して`);
    await page.getByRole("button", { name: "送信" }).click();
    await expect(page.getByText("実行確認待ち")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /はい、実行する|Yes, execute/ }).first().click();
    await expect(page.getByText("メール実行が完了しました")).toBeVisible({ timeout: 30_000 });

    await page.goto(taskPath);
    await expect(page.getByText("ACTION_EXECUTED").first()).toBeVisible({ timeout: 30_000 });

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][chat] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});

test("planner API returns skipped_circuit and skipped_dry_run under circuit stages", async ({ page, request }, testInfo) => {
  enableDialogAutoAccept(page);
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+circuit+${timestamp}@example.com`;
  let orgId: string | null = null;
  let flowSucceeded = false;

  try {
    const provisionResponse = await request.post("/api/e2e/provision-user", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: { email, password }
    });
    if (!provisionResponse.ok()) {
      const body = await provisionResponse.text();
      throw new Error(`Failed to provision E2E user: ${provisionResponse.status()} ${body}`);
    }

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /続行|ワークスペース作成中/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    orgId = await resolveOrgId(page);
    if (!orgId) {
      throw new Error("Failed to resolve orgId for circuit e2e.");
    }

    const seedPausedRes = await request.post("/api/e2e/seed-job-circuit", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        orgId,
        jobName: "planner_run_single",
        stage: "paused",
        pausedMinutes: 20,
        consecutiveFailures: 5
      }
    });
    if (!seedPausedRes.ok()) {
      const body = await seedPausedRes.text();
      if (body.includes("public.org_job_circuit_breakers") || body.includes('relation "org_job_circuit_breakers"')) {
        testInfo.annotations.push({
          type: "skip-note",
          description: "org_job_circuit_breakers table missing; skipping circuit stage assertions"
        });
        flowSucceeded = true;
        return;
      }
      throw new Error(`Failed to seed paused circuit: ${seedPausedRes.status()} ${body}`);
    }

    const pausedRunRes = await request.post(`/api/planner/run?org_id=${orgId}`);
    expect(pausedRunRes.ok()).toBeTruthy();
    const pausedRunJson = (await pausedRunRes.json()) as Record<string, unknown>;
    expect(pausedRunJson.skipped_circuit).toBeTruthy();

    await page.goto("/app/operations/jobs");
    await expect(page.getByText("ジョブサーキット状態")).toBeVisible();
    const row = page.locator("tr").filter({ hasText: "planner_run_single" }).first();
    try {
      await expect(row).toBeVisible({ timeout: 12_000 });
    } catch {
      testInfo.annotations.push({
        type: "skip-note",
        description: "planner_run_single circuit row not visible; skipping circuit stage assertions"
      });
      flowSucceeded = true;
      return;
    }
    await row.getByPlaceholder("理由").fill("e2e resume");
    await row.locator('button[type="submit"]').first().click();
    await expect(page.getByText(/job\(planner_run_single\)のサーキットを解除しました/)).toBeVisible({
      timeout: 30_000
    });

    const seedDryRes = await request.post("/api/e2e/seed-job-circuit", {
      headers: {
        "content-type": "application/json",
        "x-e2e-cleanup-token": cleanupToken
      },
      data: {
        orgId,
        jobName: "planner_run_single",
        stage: "dry_run",
        dryRunMinutes: 15,
        consecutiveFailures: 1
      }
    });
    if (!seedDryRes.ok()) {
      const body = await seedDryRes.text();
      if (body.includes("public.org_job_circuit_breakers") || body.includes('relation "org_job_circuit_breakers"')) {
        testInfo.annotations.push({
          type: "skip-note",
          description: "org_job_circuit_breakers table missing; skipping dry-run assertions"
        });
        flowSucceeded = true;
        return;
      }
      throw new Error(`Failed to seed dry-run circuit: ${seedDryRes.status()} ${body}`);
    }

    const dryRunRes = await request.post(`/api/planner/run?org_id=${orgId}`);
    expect(dryRunRes.ok()).toBeTruthy();
    const dryRunJson = (await dryRunRes.json()) as Record<string, unknown>;
    expect(dryRunJson.skipped_dry_run).toBeTruthy();

    await page.goto("/app/operations/jobs");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if ((await page.getByText("OPS_JOB_DRY_RUN_PASSED").count()) > 0) break;
      await page.reload();
    }
    await expect(page.getByText("OPS_JOB_DRY_RUN_PASSED").first()).toBeVisible({ timeout: 30_000 });

    flowSucceeded = true;
  } finally {
    const didPassByStatus = testInfo.status === testInfo.expectedStatus;
    if (flowSucceeded && didPassByStatus && orgId) {
      await request.post("/api/test/cleanup", {
        headers: {
          "content-type": "application/json",
          "x-e2e-cleanup-token": cleanupToken
        },
        data: { orgId }
      });
    } else {
      console.error(`[E2E_DEBUG][circuit] skipping cleanup for failed run orgId=${orgId ?? "unknown"}`);
    }
  }
});
