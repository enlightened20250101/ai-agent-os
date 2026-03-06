export function isMissingChatSchemaError(message: string) {
  return (
    message.includes("public.chat_") ||
    message.includes("relation \"chat_") ||
    message.includes("Could not find the table 'public.chat_")
  );
}
