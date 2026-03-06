export type ActionableErrorContext =
  | "chat_execute"
  | "workflow_start"
  | "workflow_advance"
  | "workflow_retry";

function includesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function toUserActionableError(rawMessage: string, context: ActionableErrorContext): string {
  const message = rawMessage.trim();
  if (!message) return "処理に失敗しました。時間をおいて再試行してください。";

  if (includesAny(message, ["ポリシーステータスが block", "policy status が block", "ガバナンス判定が block"])) {
    return "ポリシーにより実行できません。タスク詳細のポリシー理由を確認し、内容修正後に再実行してください。";
  }
  if (message.includes("承認者数が不足しています")) {
    return "承認者が不足しています。承認履歴で追加承認を完了してから再実行してください。";
  }
  if (includesAny(message, ["Googleコネクタが未設定", "Google connector"])) {
    return "Google連携が未設定です。`/app/integrations/google` で接続後に再実行してください。";
  }
  if (includesAny(message, ["1時間あたり実行上限", "日次実行上限"])) {
    return "実行上限に達しています。時間をあけて再実行するか、管理者に上限設定を確認してください。";
  }
  if (includesAny(message, ["すでに実行済み", "すでに実行中", "すでにキュー済み"])) {
    return message;
  }
  if (includesAny(message, ["workflow template", "workflow template を選択", "workflow template が設定されていません"])) {
    return "ワークフローテンプレートが未設定です。`/app/tasks` でテンプレートを設定してから実行してください。";
  }
  if (context === "workflow_start" && includesAny(message, ["タスク取得に失敗", "テンプレート取得に失敗"])) {
    return "ワークフロー開始対象の取得に失敗しました。タスク/テンプレートの存在を確認して再実行してください。";
  }
  if (context !== "chat_execute" && includesAny(message, ["running step が見つかりません", "failed step"])) {
    return "ワークフロー状態が変化したため処理できませんでした。最新状態を再読込して再試行してください。";
  }

  return message;
}

