begin;

create extension if not exists pgcrypto with schema public;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'actor_type_enum') then
    create type public.actor_type_enum as enum ('user', 'agent', 'system');
  end if;

  if not exists (select 1 from pg_type where typname = 'approval_status_enum') then
    create type public.approval_status_enum as enum ('pending', 'approved', 'rejected');
  end if;

  if not exists (select 1 from pg_type where typname = 'task_status_enum') then
    create type public.task_status_enum as enum (
      'draft',
      'ready_for_approval',
      'approved',
      'executing',
      'done',
      'failed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'agent_status_enum') then
    create type public.agent_status_enum as enum ('active', 'disabled');
  end if;

  if not exists (select 1 from pg_type where typname = 'action_status_enum') then
    create type public.action_status_enum as enum ('queued', 'running', 'success', 'failed');
  end if;

  if not exists (select 1 from pg_type where typname = 'provider_enum') then
    create type public.provider_enum as enum ('slack', 'google');
  end if;
end
$$;

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default timezone('utc', now()),
  constraint memberships_org_id_user_id_key unique (org_id, user_id)
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  role_key text not null,
  status public.agent_status_enum not null default 'active',
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  agent_id uuid references public.agents(id) on delete set null,
  title text not null check (char_length(trim(title)) > 0),
  input_text text not null default '',
  status public.task_status_enum not null default 'draft',
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.task_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_type public.actor_type_enum not null,
  actor_id uuid,
  event_type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  approver_user_id uuid references auth.users(id) on delete set null,
  status public.approval_status_enum not null default 'pending',
  reason text,
  created_at timestamptz not null default timezone('utc', now()),
  decided_at timestamptz
);

create table if not exists public.connector_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider public.provider_enum not null,
  external_account_id text not null,
  display_name text not null,
  secrets_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint connector_accounts_org_provider_external_key unique (org_id, provider, external_account_id)
);

create table if not exists public.actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  provider public.provider_enum not null,
  action_type text not null,
  request_json jsonb not null default '{}'::jsonb,
  status public.action_status_enum not null default 'queued',
  result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_agents_org_id on public.agents (org_id);
create index if not exists idx_tasks_org_created_at on public.tasks (org_id, created_at desc);
create index if not exists idx_task_events_task_created_at on public.task_events (task_id, created_at desc);
create index if not exists idx_approvals_task_status on public.approvals (task_id, status);
create index if not exists idx_actions_task_created_at on public.actions (task_id, created_at desc);
create index if not exists idx_memberships_user_id on public.memberships (user_id);

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.orgs to authenticated, service_role;
grant select, insert, update, delete on public.memberships to authenticated, service_role;
grant select, insert, update, delete on public.agents to authenticated, service_role;
grant select, insert, update, delete on public.tasks to authenticated, service_role;
grant select, insert, update, delete on public.task_events to authenticated, service_role;
grant select, insert, update, delete on public.approvals to authenticated, service_role;
grant select, insert, update, delete on public.connector_accounts to authenticated, service_role;
grant select, insert, update, delete on public.actions to authenticated, service_role;

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = target_org_id
      and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;

alter table public.orgs enable row level security;
alter table public.memberships enable row level security;
alter table public.agents enable row level security;
alter table public.tasks enable row level security;
alter table public.task_events enable row level security;
alter table public.approvals enable row level security;
alter table public.connector_accounts enable row level security;
alter table public.actions enable row level security;

drop policy if exists orgs_select_member on public.orgs;
create policy orgs_select_member on public.orgs
  for select
  using (public.is_org_member(id));

drop policy if exists orgs_insert_none on public.orgs;
create policy orgs_insert_none on public.orgs
  for insert
  with check (false);

drop policy if exists orgs_update_member on public.orgs;
create policy orgs_update_member on public.orgs
  for update
  using (public.is_org_member(id))
  with check (public.is_org_member(id));

drop policy if exists orgs_delete_member on public.orgs;
create policy orgs_delete_member on public.orgs
  for delete
  using (public.is_org_member(id));

drop policy if exists memberships_select_member on public.memberships;
create policy memberships_select_member on public.memberships
  for select
  using (public.is_org_member(org_id));

drop policy if exists memberships_insert_member on public.memberships;
create policy memberships_insert_member on public.memberships
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists memberships_update_member on public.memberships;
create policy memberships_update_member on public.memberships
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists memberships_delete_member on public.memberships;
create policy memberships_delete_member on public.memberships
  for delete
  using (public.is_org_member(org_id));

drop policy if exists agents_select_member on public.agents;
create policy agents_select_member on public.agents
  for select
  using (public.is_org_member(org_id));

drop policy if exists agents_insert_member on public.agents;
create policy agents_insert_member on public.agents
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists agents_update_member on public.agents;
create policy agents_update_member on public.agents
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists agents_delete_member on public.agents;
create policy agents_delete_member on public.agents
  for delete
  using (public.is_org_member(org_id));

drop policy if exists tasks_select_member on public.tasks;
create policy tasks_select_member on public.tasks
  for select
  using (public.is_org_member(org_id));

drop policy if exists tasks_insert_member on public.tasks;
create policy tasks_insert_member on public.tasks
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists tasks_update_member on public.tasks;
create policy tasks_update_member on public.tasks
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists tasks_delete_member on public.tasks;
create policy tasks_delete_member on public.tasks
  for delete
  using (public.is_org_member(org_id));

drop policy if exists task_events_select_member on public.task_events;
create policy task_events_select_member on public.task_events
  for select
  using (public.is_org_member(org_id));

drop policy if exists task_events_insert_member on public.task_events;
create policy task_events_insert_member on public.task_events
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists task_events_update_member on public.task_events;
create policy task_events_update_member on public.task_events
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists task_events_delete_member on public.task_events;
create policy task_events_delete_member on public.task_events
  for delete
  using (public.is_org_member(org_id));

drop policy if exists approvals_select_member on public.approvals;
create policy approvals_select_member on public.approvals
  for select
  using (public.is_org_member(org_id));

drop policy if exists approvals_insert_member on public.approvals;
create policy approvals_insert_member on public.approvals
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists approvals_update_member on public.approvals;
create policy approvals_update_member on public.approvals
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists approvals_delete_member on public.approvals;
create policy approvals_delete_member on public.approvals
  for delete
  using (public.is_org_member(org_id));

drop policy if exists connector_accounts_select_member on public.connector_accounts;
create policy connector_accounts_select_member on public.connector_accounts
  for select
  using (public.is_org_member(org_id));

drop policy if exists connector_accounts_insert_member on public.connector_accounts;
create policy connector_accounts_insert_member on public.connector_accounts
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists connector_accounts_update_member on public.connector_accounts;
create policy connector_accounts_update_member on public.connector_accounts
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists connector_accounts_delete_member on public.connector_accounts;
create policy connector_accounts_delete_member on public.connector_accounts
  for delete
  using (public.is_org_member(org_id));

drop policy if exists actions_select_member on public.actions;
create policy actions_select_member on public.actions
  for select
  using (public.is_org_member(org_id));

drop policy if exists actions_insert_member on public.actions;
create policy actions_insert_member on public.actions
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists actions_update_member on public.actions;
create policy actions_update_member on public.actions
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists actions_delete_member on public.actions;
create policy actions_delete_member on public.actions
  for delete
  using (public.is_org_member(org_id));

commit;
