import { postPersonalMessage } from "@/app/app/chat/actions";
import { ChatShell } from "@/app/app/chat/ChatShell";

export const dynamic = "force-dynamic";

type PersonalChatPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; cmd_status?: string }>;
};

export default function PersonalChatPage({ searchParams }: PersonalChatPageProps) {
  return (
    <ChatShell
      scope="personal"
      title="個人チャット"
      description="あなた専用のチャットです。個別確認や下書き相談などを実行確認付きで行えます。"
      submitAction={postPersonalMessage}
      searchParams={searchParams}
    />
  );
}
