begin;

create table if not exists public.slack_event_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint slack_event_receipts_event_id_key unique (event_id)
);

create index if not exists idx_slack_event_receipts_org_created_at
  on public.slack_event_receipts (org_id, created_at desc);

grant select, insert, update, delete on public.slack_event_receipts to authenticated, service_role;

alter table public.slack_event_receipts enable row level security;

drop policy if exists slack_event_receipts_select_member on public.slack_event_receipts;
create policy slack_event_receipts_select_member on public.slack_event_receipts
  for select
  using (public.is_org_member(org_id));

drop policy if exists slack_event_receipts_insert_member on public.slack_event_receipts;
create policy slack_event_receipts_insert_member on public.slack_event_receipts
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists slack_event_receipts_update_member on public.slack_event_receipts;
create policy slack_event_receipts_update_member on public.slack_event_receipts
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists slack_event_receipts_delete_member on public.slack_event_receipts;
create policy slack_event_receipts_delete_member on public.slack_event_receipts
  for delete
  using (public.is_org_member(org_id));

commit;
