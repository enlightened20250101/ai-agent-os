create table if not exists public.monitor_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  trigger_source text not null default 'manual',
  status text not null default 'running',
  planner_invoked boolean not null default false,
  planner_run_id uuid null references public.planner_runs(id) on delete set null,
  signal_counts_json jsonb not null default '{}'::jsonb,
  summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz null
);

create index if not exists idx_monitor_runs_org_created_at
  on public.monitor_runs (org_id, created_at desc);

create index if not exists idx_monitor_runs_org_status_created_at
  on public.monitor_runs (org_id, status, created_at desc);

grant select, insert, update, delete on public.monitor_runs to authenticated, service_role;

alter table public.monitor_runs enable row level security;

drop policy if exists monitor_runs_select_member on public.monitor_runs;
create policy monitor_runs_select_member on public.monitor_runs
for select to authenticated
using (is_org_member(org_id));

drop policy if exists monitor_runs_insert_member on public.monitor_runs;
create policy monitor_runs_insert_member on public.monitor_runs
for insert to authenticated
with check (is_org_member(org_id));

drop policy if exists monitor_runs_update_member on public.monitor_runs;
create policy monitor_runs_update_member on public.monitor_runs
for update to authenticated
using (is_org_member(org_id))
with check (is_org_member(org_id));

drop policy if exists monitor_runs_delete_member on public.monitor_runs;
create policy monitor_runs_delete_member on public.monitor_runs
for delete to authenticated
using (is_org_member(org_id));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'monitor_runs_status_check'
      and conrelid = 'public.monitor_runs'::regclass
  ) then
    alter table public.monitor_runs
      add constraint monitor_runs_status_check
      check (status in ('running', 'completed', 'failed', 'skipped'));
  end if;
end $$;
