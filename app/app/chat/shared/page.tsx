import { postSharedMessage } from "@/app/app/chat/actions";
import { ChatShell } from "@/app/app/chat/ChatShell";

export const dynamic = "force-dynamic";

type SharedChatPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

export default function SharedChatPage({ searchParams }: SharedChatPageProps) {
  return (
    <ChatShell
      scope="shared"
      title="共有チャット"
      description="組織全体で共有する会話です。全体タスクや運用状況の確認に使います。"
      submitAction={postSharedMessage}
      searchParams={searchParams}
    />
  );
}
