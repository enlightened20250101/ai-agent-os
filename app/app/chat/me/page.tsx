import { postPersonalMessage } from "@/app/app/chat/actions";
import { ChatShell } from "@/app/app/chat/ChatShell";
import { getAppLocale } from "@/lib/i18n/locale";

export const dynamic = "force-dynamic";

type PersonalChatPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string; cmd_status?: string }>;
};

export default async function PersonalChatPage({ searchParams }: PersonalChatPageProps) {
  const locale = await getAppLocale();
  const isEn = locale === "en";
  return (
    <ChatShell
      scope="personal"
      title={isEn ? "Personal Chat" : "個人チャット"}
      description={
        isEn
          ? "Your private thread. Agent execution runs only for messages with @AI."
          : "あなた専用のチャットです。AI実行は @AI を付けたメッセージのみ対象です。"
      }
      submitAction={postPersonalMessage}
      searchParams={searchParams}
    />
  );
}
