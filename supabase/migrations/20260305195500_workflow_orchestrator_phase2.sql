begin;

create table if not exists public.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  version int not null default 1 check (version > 0),
  definition_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  proposal_id uuid references public.task_proposals(id) on delete set null,
  template_id uuid not null references public.workflow_templates(id) on delete restrict,
  status text not null check (status in ('running', 'completed', 'failed', 'canceled')),
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  current_step_key text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  step_key text not null,
  step_index int not null check (step_index >= 0),
  step_type text not null default 'task_event',
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'skipped')),
  input_json jsonb not null default '{}'::jsonb,
  output_json jsonb not null default '{}'::jsonb,
  error_json jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  retry_count int not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  constraint workflow_steps_run_step_key_unique unique (workflow_run_id, step_key)
);

alter table public.tasks
  add column if not exists workflow_template_id uuid references public.workflow_templates(id) on delete set null;

create index if not exists idx_workflow_templates_org_created_at
  on public.workflow_templates (org_id, created_at desc);
create index if not exists idx_workflow_runs_org_created_at
  on public.workflow_runs (org_id, created_at desc);
create index if not exists idx_workflow_runs_task_id
  on public.workflow_runs (task_id);
create index if not exists idx_workflow_runs_org_status
  on public.workflow_runs (org_id, status);
create index if not exists idx_workflow_steps_run_created_at
  on public.workflow_steps (workflow_run_id, created_at);
create index if not exists idx_workflow_steps_org_status
  on public.workflow_steps (org_id, status);

grant select, insert, update, delete on public.workflow_templates to authenticated, service_role;
grant select, insert, update, delete on public.workflow_runs to authenticated, service_role;
grant select, insert, update, delete on public.workflow_steps to authenticated, service_role;

alter table public.workflow_templates enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.workflow_steps enable row level security;

drop policy if exists workflow_templates_select_member on public.workflow_templates;
create policy workflow_templates_select_member on public.workflow_templates
  for select
  using (public.is_org_member(org_id));

drop policy if exists workflow_templates_insert_member on public.workflow_templates;
create policy workflow_templates_insert_member on public.workflow_templates
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists workflow_templates_update_member on public.workflow_templates;
create policy workflow_templates_update_member on public.workflow_templates
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists workflow_templates_delete_member on public.workflow_templates;
create policy workflow_templates_delete_member on public.workflow_templates
  for delete
  using (public.is_org_member(org_id));

drop policy if exists workflow_runs_select_member on public.workflow_runs;
create policy workflow_runs_select_member on public.workflow_runs
  for select
  using (public.is_org_member(org_id));

drop policy if exists workflow_runs_insert_member on public.workflow_runs;
create policy workflow_runs_insert_member on public.workflow_runs
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists workflow_runs_update_member on public.workflow_runs;
create policy workflow_runs_update_member on public.workflow_runs
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists workflow_runs_delete_member on public.workflow_runs;
create policy workflow_runs_delete_member on public.workflow_runs
  for delete
  using (public.is_org_member(org_id));

drop policy if exists workflow_steps_select_member on public.workflow_steps;
create policy workflow_steps_select_member on public.workflow_steps
  for select
  using (public.is_org_member(org_id));

drop policy if exists workflow_steps_insert_member on public.workflow_steps;
create policy workflow_steps_insert_member on public.workflow_steps
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists workflow_steps_update_member on public.workflow_steps;
create policy workflow_steps_update_member on public.workflow_steps
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists workflow_steps_delete_member on public.workflow_steps;
create policy workflow_steps_delete_member on public.workflow_steps
  for delete
  using (public.is_org_member(org_id));

commit;
