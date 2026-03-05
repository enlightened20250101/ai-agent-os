begin;

create table if not exists public.org_job_circuit_breakers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  job_name text not null,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  paused_until timestamptz,
  last_error text,
  last_failed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint org_job_circuit_breakers_org_job_key unique (org_id, job_name)
);

create index if not exists idx_org_job_circuit_breakers_org_updated
  on public.org_job_circuit_breakers (org_id, updated_at desc);
create index if not exists idx_org_job_circuit_breakers_paused
  on public.org_job_circuit_breakers (org_id, paused_until);

grant select, insert, update, delete on public.org_job_circuit_breakers to authenticated, service_role;

alter table public.org_job_circuit_breakers enable row level security;

drop policy if exists org_job_circuit_breakers_select_member on public.org_job_circuit_breakers;
create policy org_job_circuit_breakers_select_member on public.org_job_circuit_breakers
  for select
  using (public.is_org_member(org_id));

drop policy if exists org_job_circuit_breakers_insert_member on public.org_job_circuit_breakers;
create policy org_job_circuit_breakers_insert_member on public.org_job_circuit_breakers
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists org_job_circuit_breakers_update_member on public.org_job_circuit_breakers;
create policy org_job_circuit_breakers_update_member on public.org_job_circuit_breakers
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists org_job_circuit_breakers_delete_member on public.org_job_circuit_breakers;
create policy org_job_circuit_breakers_delete_member on public.org_job_circuit_breakers
  for delete
  using (public.is_org_member(org_id));

commit;
