import { createExternalContact, createVendor, updateVendor } from "@/app/app/partners/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type PartnersPageProps = {
  searchParams?: Promise<{ ok?: string; error?: string }>;
};

export default async function PartnersPage({ searchParams }: PartnersPageProps) {
  const sp = searchParams ? await searchParams : {};
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();

  const [vendorsRes, contactsRes] = await Promise.all([
    supabase.from("vendors").select("id, name, email, status, notes, updated_at").eq("org_id", orgId).order("updated_at", { ascending: false }).limit(200),
    supabase
      .from("external_contacts")
      .select("id, display_name, email, company, notes, updated_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(200)
  ]);

  const vendorMissing = vendorsRes.error && (vendorsRes.error.message.includes('relation "vendors" does not exist') || vendorsRes.error.message.includes("Could not find the table 'public.vendors'"));
  const contactMissing = contactsRes.error && (contactsRes.error.message.includes('relation "external_contacts" does not exist') || contactsRes.error.message.includes("Could not find the table 'public.external_contacts'"));

  if ((vendorsRes.error && !vendorMissing) || (contactsRes.error && !contactMissing)) {
    throw new Error(vendorsRes.error?.message ?? contactsRes.error?.message ?? "Failed to load partners");
  }

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">取引先・社外連絡先</h1>
        <p className="mt-2 text-sm text-slate-600">取引先マスタと社外DM先を管理します。</p>
        {sp.ok ? <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{sp.ok}</p> : null}
        {sp.error ? <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{sp.error}</p> : null}
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">取引先を追加</p>
        <form action={createVendor} className="mt-3 grid gap-2 md:grid-cols-3">
          <input name="name" required placeholder="取引先名" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <input name="email" placeholder="email" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <input name="notes" placeholder="メモ" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800 md:col-span-3">
            追加
          </button>
        </form>

        {vendorMissing ? (
          <p className="mt-3 text-sm text-amber-700">`vendors` migration 未適用です。supabase db push を実行してください。</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {(vendorsRes.data ?? []).map((v) => (
              <li key={v.id} className="rounded-lg border border-slate-200 p-3">
                <p className="font-medium text-slate-900">{v.name as string}</p>
                <p className="text-xs text-slate-600">{(v.email as string | null) ?? "email未設定"}</p>
                <form action={updateVendor} className="mt-2 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={v.id as string} />
                  <select name="status" defaultValue={(v.status as string) ?? "active"} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
                    <option value="active">active</option>
                    <option value="inactive">inactive</option>
                  </select>
                  <input name="notes" defaultValue={(v.notes as string | null) ?? ""} className="min-w-[220px] rounded-md border border-slate-300 px-2 py-1 text-xs" />
                  <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">
                    更新
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">社外連絡先を追加（DM用）</p>
        <form action={createExternalContact} className="mt-3 grid gap-2 md:grid-cols-4">
          <input name="display_name" required placeholder="表示名" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <input name="email" placeholder="email" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <input name="company" placeholder="会社名" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <input name="notes" placeholder="メモ" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800 md:col-span-4">
            追加
          </button>
        </form>
        {contactMissing ? (
          <p className="mt-3 text-sm text-amber-700">`external_contacts` migration 未適用です。supabase db push を実行してください。</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {(contactsRes.data ?? []).map((c) => (
              <li key={c.id} className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">{c.display_name as string}</p>
                <p className="text-xs text-slate-600">
                  {(c.company as string | null) ?? "会社未設定"} / {(c.email as string | null) ?? "email未設定"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
