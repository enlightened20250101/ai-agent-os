begin;

alter table if exists public.user_profiles
  add column if not exists avatar_url text;

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  email text,
  status text not null default 'active' check (status in ('active','inactive')),
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists idx_vendors_org_updated on public.vendors (org_id, updated_at desc);
create unique index if not exists vendors_org_name_unique on public.vendors (org_id, lower(name));

grant select, insert, update, delete on public.vendors to authenticated, service_role;
alter table public.vendors enable row level security;
drop policy if exists vendors_select_member on public.vendors;
create policy vendors_select_member on public.vendors for select using (public.is_org_member(org_id));
drop policy if exists vendors_insert_member on public.vendors;
create policy vendors_insert_member on public.vendors for insert with check (public.is_org_member(org_id));
drop policy if exists vendors_update_member on public.vendors;
create policy vendors_update_member on public.vendors for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists vendors_delete_member on public.vendors;
create policy vendors_delete_member on public.vendors for delete using (public.is_org_member(org_id));

create table if not exists public.external_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  display_name text not null,
  email text,
  company text,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists idx_external_contacts_org_updated on public.external_contacts (org_id, updated_at desc);
grant select, insert, update, delete on public.external_contacts to authenticated, service_role;
alter table public.external_contacts enable row level security;
drop policy if exists external_contacts_select_member on public.external_contacts;
create policy external_contacts_select_member on public.external_contacts for select using (public.is_org_member(org_id));
drop policy if exists external_contacts_insert_member on public.external_contacts;
create policy external_contacts_insert_member on public.external_contacts for insert with check (public.is_org_member(org_id));
drop policy if exists external_contacts_update_member on public.external_contacts;
create policy external_contacts_update_member on public.external_contacts for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists external_contacts_delete_member on public.external_contacts;
create policy external_contacts_delete_member on public.external_contacts for delete using (public.is_org_member(org_id));

alter table if exists public.chat_channels
  add column if not exists channel_type text not null default 'group' check (channel_type in ('group', 'dm_internal', 'dm_external')),
  add column if not exists external_contact_id uuid references public.external_contacts(id) on delete set null;

create index if not exists idx_chat_channels_org_type_created
  on public.chat_channels (org_id, channel_type, created_at desc);

commit;
