create table if not exists public.org_invite_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  max_uses integer not null default 10 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_org_invite_links_org_created_at on public.org_invite_links (org_id, created_at desc);
create index if not exists idx_org_invite_links_token on public.org_invite_links (token);

grant select, insert, update, delete on public.org_invite_links to authenticated, service_role;

alter table public.org_invite_links enable row level security;

drop policy if exists org_invite_links_select_member on public.org_invite_links;
create policy org_invite_links_select_member on public.org_invite_links
for select to authenticated using (public.is_org_member(org_id));

drop policy if exists org_invite_links_insert_member on public.org_invite_links;
create policy org_invite_links_insert_member on public.org_invite_links
for insert to authenticated with check (public.is_org_member(org_id) and created_by_user_id = auth.uid());

drop policy if exists org_invite_links_update_member on public.org_invite_links;
create policy org_invite_links_update_member on public.org_invite_links
for update to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

drop policy if exists org_invite_links_delete_member on public.org_invite_links;
create policy org_invite_links_delete_member on public.org_invite_links
for delete to authenticated using (public.is_org_member(org_id));
