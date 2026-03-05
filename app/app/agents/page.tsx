import { createAgent, toggleAgentStatus } from "@/app/app/agents/actions";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";

type AgentsPageProps = {
  searchParams?: Promise<{
    error?: string;
  }>;
};

export default async function AgentsPage({ searchParams }: AgentsPageProps) {
  const { orgId } = await requireOrgContext();
  const supabase = await createClient();
  const params = searchParams ? await searchParams : {};

  const { data: agents, error } = await supabase
    .from("agents")
    .select("id, name, role_key, status, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load agents: ${error.message}`);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">エージェント</h1>
        <p className="mt-2 text-sm text-slate-600">実行プロファイルを作成・管理します。</p>

        {params.error ? (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {params.error}
          </p>
        ) : null}

        <form action={createAgent} className="mt-6 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <input
            type="text"
            name="name"
            placeholder="エージェント名"
            required
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            name="role_key"
            placeholder="role_key（例: support_writer）"
            required
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            エージェントを作成
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">エージェント一覧</h2>
        {agents && agents.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="flex flex-col gap-3 rounded-md border border-slate-200 p-4 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <p className="font-medium text-slate-900">{agent.name}</p>
                  <p className="text-sm text-slate-600">
                    role_key: {agent.role_key} | ステータス: {agent.status}
                  </p>
                </div>
                <form action={toggleAgentStatus}>
                  <input type="hidden" name="agent_id" value={agent.id} />
                  <input type="hidden" name="current_status" value={agent.status} />
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                  >
                    {agent.status === "active" ? "無効化" : "有効化"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-slate-600">エージェントはまだありません。上から作成してください。</p>
        )}
      </section>
    </div>
  );
}
