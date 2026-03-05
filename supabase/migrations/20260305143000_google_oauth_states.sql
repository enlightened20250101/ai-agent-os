begin;

create table if not exists public.google_oauth_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nonce text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists idx_google_oauth_states_nonce on public.google_oauth_states (nonce);
create index if not exists idx_google_oauth_states_org_id on public.google_oauth_states (org_id);
create index if not exists idx_google_oauth_states_user_id on public.google_oauth_states (user_id);

grant select, insert, update on public.google_oauth_states to authenticated, service_role;

alter table public.google_oauth_states enable row level security;

drop policy if exists google_oauth_states_select on public.google_oauth_states;
create policy google_oauth_states_select on public.google_oauth_states
  for select
  using (auth.uid() = user_id and public.is_org_member(org_id));

drop policy if exists google_oauth_states_insert on public.google_oauth_states;
create policy google_oauth_states_insert on public.google_oauth_states
  for insert
  with check (auth.uid() = user_id and public.is_org_member(org_id));

drop policy if exists google_oauth_states_update on public.google_oauth_states;
create policy google_oauth_states_update on public.google_oauth_states
  for update
  using (auth.uid() = user_id and public.is_org_member(org_id))
  with check (auth.uid() = user_id and public.is_org_member(org_id));

commit;
