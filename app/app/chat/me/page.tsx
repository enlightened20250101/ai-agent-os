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
          ? "A private thread for your own checks and draft operations with confirmations."
          : "あなた専用のチャットです。個別確認や下書き相談などを実行確認付きで行えます。"
      }
      submitAction={postPersonalMessage}
      searchParams={searchParams}
    />
  );
}
