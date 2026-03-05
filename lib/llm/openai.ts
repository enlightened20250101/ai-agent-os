type ProposedAction = {
  provider: "google";
  action_type: "send_email";
  to: string;
  subject: string;
  body_text: string;
};

export type DraftOutput = {
  summary: string;
  proposed_actions: ProposedAction[];
  risks: string[];
};

type DraftNormalizationMetadata = {
  coercions: string[];
  rawModelOutput: string | null;
};

type GenerateDraftInput = {
  roleKey: string;
  title: string;
  inputText: string;
};

function getAllowedDomainForStub() {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw) {
    return "example.com";
  }
  return (
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)[0] ?? "example.com"
  );
}

function makeStubDraft(input: GenerateDraftInput): DraftOutput {
  const domain = getAllowedDomainForStub();
  return {
    summary: `Drafted response for ${input.title}`,
    proposed_actions: [
      {
        provider: "google",
        action_type: "send_email",
        to: `ap@${domain}`,
        subject: `Re: ${input.title}`,
        body_text: `Hello,\n\nBased on the request: "${input.inputText}", here is the draft response.\n\nBest regards`
      }
    ],
    risks: ["Verify recipient and final numbers before sending."]
  };
}

function normalizeDraftOutput(raw: unknown): {
  output: DraftOutput;
  metadata: DraftNormalizationMetadata;
} {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Model output is not an object.");
  }
  const metadata: DraftNormalizationMetadata = {
    coercions: [],
    rawModelOutput: JSON.stringify(raw).slice(0, 2000)
  };

  const data = raw as Record<string, unknown>;
  const summary = data.summary;

  if (typeof summary !== "string") {
    throw new Error("Model output summary is invalid.");
  }

  let parsedActions: ProposedAction[] = [];
  if (Array.isArray(data.proposed_actions)) {
    parsedActions = data.proposed_actions
      .map((item) => {
        if (typeof item !== "object" || item === null) {
          return null;
        }
        const action = item as Record<string, unknown>;
        if (
          action.provider !== "google" ||
          action.action_type !== "send_email" ||
          typeof action.to !== "string" ||
          typeof action.subject !== "string" ||
          typeof action.body_text !== "string"
        ) {
          return null;
        }
        return {
          provider: "google" as const,
          action_type: "send_email" as const,
          to: action.to,
          subject: action.subject,
          body_text: action.body_text
        };
      })
      .filter((value): value is ProposedAction => value !== null);
    if (parsedActions.length !== data.proposed_actions.length) {
      metadata.coercions.push("proposed_actions: dropped invalid items");
    }
  } else {
    metadata.coercions.push("proposed_actions: coerced to []");
  }

  let risks: string[] = [];
  if (Array.isArray(data.risks)) {
    risks = data.risks.filter((item): item is string => typeof item === "string");
    if (risks.length !== data.risks.length) {
      metadata.coercions.push("risks: dropped non-string items");
    }
  } else {
    metadata.coercions.push("risks: coerced to []");
  }

  return {
    output: {
      summary,
      proposed_actions: parsedActions,
      risks
    },
    metadata
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function generateDraftWithOpenAI(input: GenerateDraftInput): Promise<{
  model: string;
  output: DraftOutput;
  latencyMs: number;
  metadata: DraftNormalizationMetadata;
}> {
  const startedAt = Date.now();
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  if (process.env.E2E_MODE === "1") {
    const stubOutput = makeStubDraft(input);
    return {
      model: `${model}-stub`,
      output: stubOutput,
      latencyMs: Date.now() - startedAt,
      metadata: {
        coercions: [],
        rawModelOutput: JSON.stringify(stubOutput).slice(0, 2000)
      }
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const prompt = [
    "Return JSON only. No markdown.",
    "Output shape:",
    '{ "summary": string, "proposed_actions": array, "risks": array }',
    "Constraints:",
    '- summary: required non-empty string.',
    '- proposed_actions: array (can be empty). If present, each item must include provider="google", action_type="send_email", to, subject, body_text (all strings).',
    "- risks: array of strings (can be empty).",
    "Task context:",
    `role_key=${input.roleKey}`,
    `title=${input.title}`,
    `input_text=${input.inputText}`
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You produce strict JSON only. No markdown, no prose outside JSON. Keep response concise."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText.slice(0, 500)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned empty content.");
  }

  const parsed = safeJsonParse(content);
  if (!parsed) {
    throw new Error("OpenAI content was not valid JSON.");
  }

  const normalized = normalizeDraftOutput(parsed);

  return {
    model,
    output: normalized.output,
    latencyMs: Date.now() - startedAt,
    metadata: normalized.metadata
  };
}
