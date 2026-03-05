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

function parseDraftOutput(raw: unknown): DraftOutput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Model output is not an object.");
  }
  const data = raw as Record<string, unknown>;
  const summary = data.summary;
  const proposedActions = data.proposed_actions;
  const risks = data.risks;

  if (typeof summary !== "string") {
    throw new Error("Model output summary is invalid.");
  }
  if (!Array.isArray(proposedActions)) {
    throw new Error("Model output proposed_actions is invalid.");
  }
  if (!Array.isArray(risks) || !risks.every((item) => typeof item === "string")) {
    throw new Error("Model output risks is invalid.");
  }

  const parsedActions: ProposedAction[] = proposedActions.map((item, idx) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`Action at index ${idx} is invalid.`);
    }
    const action = item as Record<string, unknown>;
    if (action.provider !== "google" || action.action_type !== "send_email") {
      throw new Error(`Action at index ${idx} has invalid provider/action_type.`);
    }
    if (
      typeof action.to !== "string" ||
      typeof action.subject !== "string" ||
      typeof action.body_text !== "string"
    ) {
      throw new Error(`Action at index ${idx} has invalid fields.`);
    }
    return {
      provider: "google",
      action_type: "send_email",
      to: action.to,
      subject: action.subject,
      body_text: action.body_text
    };
  });

  return {
    summary,
    proposed_actions: parsedActions,
    risks
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
}> {
  const startedAt = Date.now();
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  if (process.env.E2E_MODE === "1") {
    return {
      model: `${model}-stub`,
      output: makeStubDraft(input),
      latencyMs: Date.now() - startedAt
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const prompt = [
    "Return JSON only with keys: summary, proposed_actions, risks.",
    "Constraints:",
    '- proposed_actions must be an array of objects with provider="google", action_type="send_email", to, subject, body_text.',
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

  return {
    model,
    output: parseDraftOutput(parsed),
    latencyMs: Date.now() - startedAt
  };
}
