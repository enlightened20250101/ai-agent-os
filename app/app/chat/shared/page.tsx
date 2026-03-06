import { postSharedMessage } from "@/app/app/chat/actions";
import { ChatShell } from "@/app/app/chat/ChatShell";
import { getAppLocale } from "@/lib/i18n/locale";

export const dynamic = "force-dynamic";

type SharedChatPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; cmd_status?: string }>;
};

export default async function SharedChatPage({ searchParams }: SharedChatPageProps) {
  const locale = await getAppLocale();
  const isEn = locale === "en";
  return (
    <ChatShell
      scope="shared"
      title={isEn ? "Shared Chat" : "共有チャット"}
      description={
        isEn
          ? "A workspace-wide conversation for team tasks and operational checks."
          : "組織全体で共有する会話です。全体タスクや運用状況の確認に使います。"
      }
      submitAction={postSharedMessage}
      searchParams={searchParams}
    />
  );
}
