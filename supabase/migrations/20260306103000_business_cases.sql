begin;

create table if not exists public.business_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  case_type text not null default 'general',
  title text not null check (char_length(trim(title)) > 0),
  status text not null default 'open' check (status in ('open', 'blocked', 'closed')),
  source text not null default 'manual',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_business_cases_org_created_at
  on public.business_cases (org_id, created_at desc);
create index if not exists idx_business_cases_org_status_updated_at
  on public.business_cases (org_id, status, updated_at desc);

grant select, insert, update, delete on public.business_cases to authenticated, service_role;

alter table public.business_cases enable row level security;

drop policy if exists business_cases_select_member on public.business_cases;
create policy business_cases_select_member on public.business_cases
  for select
  using (public.is_org_member(org_id));

drop policy if exists business_cases_insert_member on public.business_cases;
create policy business_cases_insert_member on public.business_cases
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists business_cases_update_member on public.business_cases;
create policy business_cases_update_member on public.business_cases
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists business_cases_delete_member on public.business_cases;
create policy business_cases_delete_member on public.business_cases
  for delete
  using (public.is_org_member(org_id));

alter table public.tasks
  add column if not exists case_id uuid references public.business_cases(id) on delete set null;

create index if not exists idx_tasks_org_case_created_at
  on public.tasks (org_id, case_id, created_at desc);

commit;
