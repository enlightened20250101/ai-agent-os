begin;

create table if not exists public.org_incidents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'resolved')),
  severity text not null default 'critical' check (severity in ('info', 'warning', 'critical')),
  reason text not null check (char_length(trim(reason)) > 0),
  metadata_json jsonb not null default '{}'::jsonb,
  opened_by uuid,
  opened_at timestamptz not null default timezone('utc', now()),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_org_incidents_org_status_opened_at
  on public.org_incidents (org_id, status, opened_at desc);

grant select, insert, update, delete on public.org_incidents to authenticated, service_role;

alter table public.org_incidents enable row level security;

drop policy if exists org_incidents_select_member on public.org_incidents;
create policy org_incidents_select_member on public.org_incidents
  for select
  using (public.is_org_member(org_id));

drop policy if exists org_incidents_insert_member on public.org_incidents;
create policy org_incidents_insert_member on public.org_incidents
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists org_incidents_update_member on public.org_incidents;
create policy org_incidents_update_member on public.org_incidents
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists org_incidents_delete_member on public.org_incidents;
create policy org_incidents_delete_member on public.org_incidents
  for delete
  using (public.is_org_member(org_id));

commit;
