begin;

create table if not exists public.incident_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid not null references public.org_incidents(id) on delete cascade,
  event_type text not null check (char_length(trim(event_type)) > 0),
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_incident_events_org_created_at
  on public.incident_events (org_id, created_at desc);
create index if not exists idx_incident_events_incident_created_at
  on public.incident_events (incident_id, created_at);
create index if not exists idx_incident_events_org_event_type_created_at
  on public.incident_events (org_id, event_type, created_at desc);

grant select, insert, update, delete on public.incident_events to authenticated, service_role;

alter table public.incident_events enable row level security;

drop policy if exists incident_events_select_member on public.incident_events;
create policy incident_events_select_member on public.incident_events
  for select
  using (public.is_org_member(org_id));

drop policy if exists incident_events_insert_member on public.incident_events;
create policy incident_events_insert_member on public.incident_events
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists incident_events_update_member on public.incident_events;
create policy incident_events_update_member on public.incident_events
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists incident_events_delete_member on public.incident_events;
create policy incident_events_delete_member on public.incident_events
  for delete
  using (public.is_org_member(org_id));

commit;
