import { createHash } from "crypto";

type GoogleSendEmailIdempotencyInput = {
  taskId: string;
  provider: "google";
  actionType: "send_email";
  to: string;
  subject: string;
  bodyText: string;
};

export function computeGoogleSendEmailIdempotencyKey(input: GoogleSendEmailIdempotencyInput) {
  return createHash("sha256")
    .update(
      [
        input.taskId,
        input.provider,
        input.actionType,
        input.to.trim().toLowerCase(),
        input.subject.trim(),
        input.bodyText.trim()
      ].join("|"),
      "utf8"
    )
    .digest("hex");
}
