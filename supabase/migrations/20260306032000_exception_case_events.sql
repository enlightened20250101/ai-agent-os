begin;

create table if not exists public.exception_case_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  exception_case_id uuid not null references public.exception_cases(id) on delete cascade,
  actor_user_id uuid,
  event_type text not null check (char_length(trim(event_type)) > 0),
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_exception_case_events_org_created_at
  on public.exception_case_events (org_id, created_at desc);
create index if not exists idx_exception_case_events_case_created_at
  on public.exception_case_events (exception_case_id, created_at);
create index if not exists idx_exception_case_events_org_event_created_at
  on public.exception_case_events (org_id, event_type, created_at desc);

grant select, insert, update, delete on public.exception_case_events to authenticated, service_role;

alter table public.exception_case_events enable row level security;

drop policy if exists exception_case_events_select_member on public.exception_case_events;
create policy exception_case_events_select_member on public.exception_case_events
  for select
  using (public.is_org_member(org_id));

drop policy if exists exception_case_events_insert_member on public.exception_case_events;
create policy exception_case_events_insert_member on public.exception_case_events
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists exception_case_events_update_member on public.exception_case_events;
create policy exception_case_events_update_member on public.exception_case_events
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists exception_case_events_delete_member on public.exception_case_events;
create policy exception_case_events_delete_member on public.exception_case_events
  for delete
  using (public.is_org_member(org_id));

commit;
