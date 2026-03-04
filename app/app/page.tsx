import Link from "next/link";

const links = [
  {
    title: "Agents",
    href: "/app/agents",
    description: "Manage connector-capable agents and drafting behavior."
  },
  {
    title: "Tasks",
    href: "/app/tasks",
    description: "Review incoming Slack tasks and processing status."
  },
  {
    title: "Approvals",
    href: "/app/approvals",
    description: "Inspect pending approvals and recent decisions."
  }
];

export default function AppHomePage() {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workspace</h1>
        <p className="mt-2 text-slate-600">Start from one of the core MVP areas below.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {links.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow"
          >
            <h2 className="font-medium text-slate-900">{item.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{item.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
