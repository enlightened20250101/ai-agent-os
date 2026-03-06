begin;

create table if not exists public.case_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  case_id uuid not null references public.business_cases(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_case_events_case_created_at
  on public.case_events (case_id, created_at desc);
create index if not exists idx_case_events_org_event_created_at
  on public.case_events (org_id, event_type, created_at desc);

grant select, insert, update, delete on public.case_events to authenticated, service_role;

alter table public.case_events enable row level security;

drop policy if exists case_events_select_member on public.case_events;
create policy case_events_select_member on public.case_events
  for select
  using (public.is_org_member(org_id));

drop policy if exists case_events_insert_member on public.case_events;
create policy case_events_insert_member on public.case_events
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists case_events_update_member on public.case_events;
create policy case_events_update_member on public.case_events
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists case_events_delete_member on public.case_events;
create policy case_events_delete_member on public.case_events
  for delete
  using (public.is_org_member(org_id));

commit;
