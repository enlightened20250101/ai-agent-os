begin;

create table if not exists public.external_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'slack', 'system', 'webhook')),
  event_type text not null,
  external_event_id text,
  summary_text text,
  payload_json jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'processed', 'ignored', 'failed')),
  source text not null default 'api',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  triage_note text,
  triaged_at timestamptz,
  linked_case_id uuid references public.business_cases(id) on delete set null,
  occurred_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_external_events_org_provider_external_id_unique
  on public.external_events (org_id, provider, external_event_id)
  where external_event_id is not null;

create index if not exists idx_external_events_org_status_created_at
  on public.external_events (org_id, status, created_at desc);

create index if not exists idx_external_events_org_occurred_at
  on public.external_events (org_id, occurred_at desc);

create index if not exists idx_external_events_org_priority_created_at
  on public.external_events (org_id, priority, created_at desc);

create index if not exists idx_external_events_org_linked_case
  on public.external_events (org_id, linked_case_id);

grant select, insert, update, delete on public.external_events to authenticated, service_role;

alter table public.external_events enable row level security;

drop policy if exists external_events_select_member on public.external_events;
create policy external_events_select_member on public.external_events
  for select
  using (public.is_org_member(org_id));

drop policy if exists external_events_insert_member on public.external_events;
create policy external_events_insert_member on public.external_events
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists external_events_update_member on public.external_events;
create policy external_events_update_member on public.external_events
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists external_events_delete_member on public.external_events;
create policy external_events_delete_member on public.external_events
  for delete
  using (public.is_org_member(org_id));

commit;
