import crypto from "node:crypto";

type SlackActionDecision = "approved" | "rejected";

type ActionTokenPayload = {
  approvalId: string;
  decision: SlackActionDecision;
  exp: number;
};

function signPayload(secret: string, payload: ActionTokenPayload) {
  const body = `${payload.approvalId}:${payload.decision}:${payload.exp}`;
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

export function createApprovalActionToken(args: {
  signingSecret: string;
  approvalId: string;
  decision: SlackActionDecision;
  ttlSec?: number;
}) {
  const { signingSecret, approvalId, decision, ttlSec = 60 * 30 } = args;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload: ActionTokenPayload = {
    approvalId,
    decision,
    exp
  };
  const sig = signPayload(signingSecret, payload);
  return `${payload.approvalId}:${payload.decision}:${payload.exp}:${sig}`;
}

export function verifyApprovalActionToken(args: {
  signingSecret: string;
  token: string;
}): ActionTokenPayload | null {
  const { signingSecret, token } = args;
  const [approvalId, decision, expRaw, sig] = token.split(":");
  if (!approvalId || !decision || !expRaw || !sig) {
    return null;
  }
  if (decision !== "approved" && decision !== "rejected") {
    return null;
  }
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  const payload: ActionTokenPayload = { approvalId, decision, exp };
  const expected = signPayload(signingSecret, payload);

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(sig, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return null;
  }

  return payload;
}
