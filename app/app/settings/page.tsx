import { updateLocale } from "@/app/app/settings/actions";
import { getAppLocale } from "@/lib/i18n/locale";

export const dynamic = "force-dynamic";

type SettingsPageProps = {
  searchParams?: Promise<{ ok?: string }>;
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const locale = await getAppLocale();
  const sp = searchParams ? await searchParams : {};
  const isEn = locale === "en";

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">{isEn ? "Settings" : "設定"}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {isEn ? "Manage language and display preferences." : "言語や表示設定を管理します。"}
        </p>
      </header>

      {sp.ok === "language_updated" ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {isEn ? "Language updated." : "言語を更新しました。"}
        </p>
      ) : null}

      <form action={updateLocale} className="max-w-sm space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <input type="hidden" name="return_to" value="/app/settings" />
        <label htmlFor="locale" className="block text-sm font-medium text-slate-800">
          {isEn ? "Language" : "言語"}
        </label>
        <select
          id="locale"
          name="locale"
          defaultValue={locale}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          {isEn ? "Save" : "保存"}
        </button>
      </form>
    </section>
  );
}
