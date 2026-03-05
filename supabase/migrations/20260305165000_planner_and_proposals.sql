begin;

create table if not exists public.planner_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.task_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source text not null,
  title text not null check (char_length(trim(title)) > 0),
  rationale text not null default '',
  proposed_actions_json jsonb not null default '[]'::jsonb,
  risks_json jsonb not null default '[]'::jsonb,
  policy_status text not null check (policy_status in ('pass', 'warn', 'block')),
  policy_reasons jsonb not null default '[]'::jsonb,
  status text not null check (status in ('proposed', 'accepted', 'rejected', 'executed')),
  created_at timestamptz not null default timezone('utc', now()),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null
);

create table if not exists public.proposal_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  proposal_id uuid references public.task_proposals(id) on delete cascade,
  event_type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_planner_runs_org_created_at on public.planner_runs (org_id, created_at desc);
create index if not exists idx_planner_runs_org_status on public.planner_runs (org_id, status);
create index if not exists idx_task_proposals_org_created_at on public.task_proposals (org_id, created_at desc);
create index if not exists idx_task_proposals_org_status on public.task_proposals (org_id, status);
create index if not exists idx_task_proposals_org_policy_status on public.task_proposals (org_id, policy_status);
create index if not exists idx_proposal_events_org_created_at on public.proposal_events (org_id, created_at desc);
create index if not exists idx_proposal_events_proposal_id_created_at on public.proposal_events (proposal_id, created_at desc);

grant select, insert, update, delete on public.planner_runs to authenticated, service_role;
grant select, insert, update, delete on public.task_proposals to authenticated, service_role;
grant select, insert, update, delete on public.proposal_events to authenticated, service_role;

alter table public.planner_runs enable row level security;
alter table public.task_proposals enable row level security;
alter table public.proposal_events enable row level security;

drop policy if exists planner_runs_select_member on public.planner_runs;
create policy planner_runs_select_member on public.planner_runs
  for select
  using (public.is_org_member(org_id));

drop policy if exists planner_runs_insert_member on public.planner_runs;
create policy planner_runs_insert_member on public.planner_runs
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists planner_runs_update_member on public.planner_runs;
create policy planner_runs_update_member on public.planner_runs
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists planner_runs_delete_member on public.planner_runs;
create policy planner_runs_delete_member on public.planner_runs
  for delete
  using (public.is_org_member(org_id));

drop policy if exists task_proposals_select_member on public.task_proposals;
create policy task_proposals_select_member on public.task_proposals
  for select
  using (public.is_org_member(org_id));

drop policy if exists task_proposals_insert_member on public.task_proposals;
create policy task_proposals_insert_member on public.task_proposals
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists task_proposals_update_member on public.task_proposals;
create policy task_proposals_update_member on public.task_proposals
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists task_proposals_delete_member on public.task_proposals;
create policy task_proposals_delete_member on public.task_proposals
  for delete
  using (public.is_org_member(org_id));

drop policy if exists proposal_events_select_member on public.proposal_events;
create policy proposal_events_select_member on public.proposal_events
  for select
  using (public.is_org_member(org_id));

drop policy if exists proposal_events_insert_member on public.proposal_events;
create policy proposal_events_insert_member on public.proposal_events
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists proposal_events_update_member on public.proposal_events;
create policy proposal_events_update_member on public.proposal_events
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists proposal_events_delete_member on public.proposal_events;
create policy proposal_events_delete_member on public.proposal_events
  for delete
  using (public.is_org_member(org_id));

commit;
