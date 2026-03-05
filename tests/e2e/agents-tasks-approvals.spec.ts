import { expect, test } from "@playwright/test";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var for E2E: ${name}`);
  }
  return value;
}

test("agents -> tasks -> approvals flow", async ({ page, request }, testInfo) => {
  const password = requireEnv("E2E_PASSWORD");
  const cleanupToken = requireEnv("E2E_CLEANUP_TOKEN");

  const timestamp = Date.now();
  const email = `e2e+${timestamp}@example.com`;
  const agentName = "E2E Agent";
  const taskTitle = `E2E Task ${timestamp}`;
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
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Login" }).click();

    await page.waitForURL(/\/app(\/onboarding)?/);

    if (new URL(page.url()).pathname === "/app/onboarding") {
      await Promise.race([
        page.waitForURL("/app", { timeout: 15_000 }),
        (async () => {
          const continueButton = page.getByRole("button", { name: /Continue|Creating workspace/ });
          await expect(continueButton).toBeVisible();
          await continueButton.click();
          await page.waitForURL("/app", { timeout: 30_000 });
        })()
      ]);
    }

    await expect(page).toHaveURL(/\/app$/);
    const orgContextText = await page.getByText(/Org context:\s+/).innerText();
    orgId = orgContextText.split("Org context:")[1]?.trim() ?? null;

    await page.goto("/app/agents");
    await page.getByPlaceholder("Agent name").fill(agentName);
    await page.getByPlaceholder("role_key (e.g. support_writer)").fill("accounting");
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByText(`role_key: accounting | status: active`)).toBeVisible();

    await page.goto("/app/tasks");
    const agentSelect = page.getByRole("combobox").first();
    const agentOptionValue = await agentSelect
      .locator("option")
      .filter({ hasText: "E2E Agent (active)" })
      .first()
      .getAttribute("value");
    if (!agentOptionValue) {
      throw new Error("Could not find E2E Agent option.");
    }
    await agentSelect.selectOption(agentOptionValue);
    await page.getByPlaceholder("Task title").fill(taskTitle);
    await page.getByPlaceholder("Task input").fill("Please draft an email to vendor.");
    await page.getByRole("button", { name: "Create Task" }).click();

    await page.getByRole("link", { name: taskTitle }).first().click();
    await expect(page).toHaveURL(/\/app\/tasks\/.+/);
    taskPath = new URL(page.url()).pathname;
    taskId = taskPath.split("/").pop() ?? null;

    await page.getByRole("button", { name: "Generate Draft" }).click();
    await expect(page.getByText("MODEL_INFERRED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("POLICY_CHECKED").first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Request Approval" }).click();
    await expect(page.getByText("APPROVAL_REQUESTED")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/approvals");
    let row = page.locator("li").filter({ hasText: taskTitle }).first();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await row.count()) {
        break;
      }
      await page.reload();
      row = page.locator("li").filter({ hasText: taskTitle }).first();
    }
    await expect(row).toBeVisible();
    await row.getByPlaceholder("Reason (optional)").fill("ok");
    await Promise.all([
      page.waitForResponse((response) => {
        return response.url().includes("/app/approvals") && response.request().method() === "POST";
      }),
      row.getByRole("button", { name: "Approve" }).click()
    ]);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const pendingRow = page.locator("li").filter({ hasText: taskTitle }).first();
      if ((await pendingRow.count()) === 0) {
        break;
      }
      await page.reload();
    }

    await expect(page.locator("li").filter({ hasText: taskTitle })).toHaveCount(0);

    if (!taskPath) {
      throw new Error("Task path not captured.");
    }
    await page.goto(taskPath);
    const taskHeaderSection = page.locator("section").first();
    await expect(taskHeaderSection.getByText(/^Status: approved$/)).toBeVisible();

    await page.getByRole("button", { name: "Execute Email" }).click();
    await expect(page.getByText("ACTION_EXECUTED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Latest action status:\s*success/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Current draft action already executed successfully.")).toBeVisible({
      timeout: 30_000
    });

    await page.getByRole("button", { name: "Execute Email" }).click();
    await expect(page.getByText("ACTION_SKIPPED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("ACTION_EXECUTED")).toHaveCount(1);

    await expect(page.getByText("TASK_CREATED").first()).toBeVisible();
    await expect(page.getByText("APPROVAL_REQUESTED").first()).toBeVisible();
    await expect(page.getByText("HUMAN_APPROVED").first()).toBeVisible();

    if (!taskId) {
      throw new Error("Task id not captured.");
    }
    await page.goto(`/app/tasks/${taskId}/evidence`);
    await expect(page.getByText("Task Summary")).toBeVisible();
    await expect(page.getByText("MODEL_INFERRED").first()).toBeVisible();
    await expect(page.getByText("POLICY_CHECKED").first()).toBeVisible();
    await expect(page.getByText("ACTION_EXECUTED").first()).toBeVisible();
    await expect(page.getByText(`title: ${taskTitle}`).first()).toBeVisible();

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
