begin;

create table if not exists public.exception_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('failed_action', 'failed_workflow', 'stale_approval', 'policy_block')),
  ref_id text not null check (char_length(trim(ref_id)) > 0),
  task_id uuid references public.tasks(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  owner_user_id uuid,
  note text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz,
  unique (org_id, kind, ref_id)
);

create index if not exists idx_exception_cases_org_status_updated_at
  on public.exception_cases (org_id, status, updated_at desc);
create index if not exists idx_exception_cases_org_kind_updated_at
  on public.exception_cases (org_id, kind, updated_at desc);
create index if not exists idx_exception_cases_org_owner_updated_at
  on public.exception_cases (org_id, owner_user_id, updated_at desc);

grant select, insert, update, delete on public.exception_cases to authenticated, service_role;

alter table public.exception_cases enable row level security;

drop policy if exists exception_cases_select_member on public.exception_cases;
create policy exception_cases_select_member on public.exception_cases
  for select
  using (public.is_org_member(org_id));

drop policy if exists exception_cases_insert_member on public.exception_cases;
create policy exception_cases_insert_member on public.exception_cases
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists exception_cases_update_member on public.exception_cases;
create policy exception_cases_update_member on public.exception_cases
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists exception_cases_delete_member on public.exception_cases;
create policy exception_cases_delete_member on public.exception_cases
  for delete
  using (public.is_org_member(org_id));

commit;
