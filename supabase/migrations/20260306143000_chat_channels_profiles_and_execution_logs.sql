begin;

create table if not exists public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  description text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists chat_channels_org_name_unique
  on public.chat_channels (org_id, lower(name));
create index if not exists idx_chat_channels_org_created
  on public.chat_channels (org_id, created_at desc);

create table if not exists public.chat_channel_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists chat_channel_members_unique
  on public.chat_channel_members (channel_id, user_id);
create index if not exists idx_chat_channel_members_org_user
  on public.chat_channel_members (org_id, user_id);

alter table if exists public.chat_sessions
  drop constraint if exists chat_sessions_scope_check;

alter table if exists public.chat_sessions
  add column if not exists channel_id uuid references public.chat_channels(id) on delete cascade;

alter table if exists public.chat_sessions
  add constraint chat_sessions_scope_check
  check (scope in ('shared', 'personal', 'channel'));

create unique index if not exists chat_sessions_org_channel_unique
  on public.chat_sessions (org_id, channel_id)
  where scope = 'channel';

create index if not exists idx_chat_sessions_org_channel_updated
  on public.chat_sessions (org_id, channel_id, updated_at desc)
  where scope = 'channel';

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text,
  avatar_emoji text not null default '🙂',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists user_profiles_org_user_unique
  on public.user_profiles (org_id, user_id);

create table if not exists public.ai_execution_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  triggered_by_user_id uuid references auth.users(id) on delete set null,
  session_id uuid references public.chat_sessions(id) on delete set null,
  session_scope text,
  channel_id uuid references public.chat_channels(id) on delete set null,
  intent_type text,
  execution_status text not null check (execution_status in ('pending','running','done','failed','cancelled','declined','skipped')),
  execution_ref_type text,
  execution_ref_id uuid,
  source text not null default 'chat',
  summary_text text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz
);

create index if not exists idx_ai_execution_logs_org_created
  on public.ai_execution_logs (org_id, created_at desc);
create index if not exists idx_ai_execution_logs_org_user_created
  on public.ai_execution_logs (org_id, triggered_by_user_id, created_at desc);
create index if not exists idx_ai_execution_logs_org_source_status_created
  on public.ai_execution_logs (org_id, source, execution_status, created_at desc);

create or replace function public.is_chat_channel_member(_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_channel_members m
    where m.channel_id = _channel_id
      and m.user_id = auth.uid()
  );
$$;

grant execute on function public.is_chat_channel_member(uuid) to authenticated, service_role;

create or replace function public.is_chat_session_accessible(_org_id uuid, _session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_sessions s
    where s.id = _session_id
      and s.org_id = _org_id
      and public.is_org_member(_org_id)
      and (
        s.scope = 'shared'
        or (s.scope = 'personal' and s.owner_user_id = auth.uid())
        or (s.scope = 'channel' and s.channel_id is not null and public.is_chat_channel_member(s.channel_id))
      )
  );
$$;

create or replace function public.is_chat_message_accessible(_org_id uuid, _message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_messages m
    join public.chat_sessions s on s.id = m.session_id
    where m.id = _message_id
      and m.org_id = _org_id
      and s.org_id = _org_id
      and public.is_org_member(_org_id)
      and (
        s.scope = 'shared'
        or (s.scope = 'personal' and s.owner_user_id = auth.uid())
        or (s.scope = 'channel' and s.channel_id is not null and public.is_chat_channel_member(s.channel_id))
      )
  );
$$;

grant execute on function public.is_chat_session_accessible(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_chat_message_accessible(uuid, uuid) to authenticated, service_role;

grant select, insert, update, delete on public.chat_channels to authenticated, service_role;
grant select, insert, update, delete on public.chat_channel_members to authenticated, service_role;
grant select, insert, update, delete on public.user_profiles to authenticated, service_role;
grant select, insert, update, delete on public.ai_execution_logs to authenticated, service_role;

alter table public.chat_channels enable row level security;
alter table public.chat_channel_members enable row level security;
alter table public.user_profiles enable row level security;
alter table public.ai_execution_logs enable row level security;

drop policy if exists chat_channels_select_member on public.chat_channels;
create policy chat_channels_select_member on public.chat_channels
  for select using (public.is_org_member(org_id));
drop policy if exists chat_channels_insert_member on public.chat_channels;
create policy chat_channels_insert_member on public.chat_channels
  for insert with check (public.is_org_member(org_id) and created_by_user_id = auth.uid());
drop policy if exists chat_channels_update_member on public.chat_channels;
create policy chat_channels_update_member on public.chat_channels
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists chat_channels_delete_member on public.chat_channels;
create policy chat_channels_delete_member on public.chat_channels
  for delete using (public.is_org_member(org_id));

drop policy if exists chat_channel_members_select_member on public.chat_channel_members;
create policy chat_channel_members_select_member on public.chat_channel_members
  for select using (public.is_org_member(org_id));
drop policy if exists chat_channel_members_insert_member on public.chat_channel_members;
create policy chat_channel_members_insert_member on public.chat_channel_members
  for insert with check (public.is_org_member(org_id));
drop policy if exists chat_channel_members_update_member on public.chat_channel_members;
create policy chat_channel_members_update_member on public.chat_channel_members
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists chat_channel_members_delete_member on public.chat_channel_members;
create policy chat_channel_members_delete_member on public.chat_channel_members
  for delete using (public.is_org_member(org_id));

drop policy if exists user_profiles_select_member on public.user_profiles;
create policy user_profiles_select_member on public.user_profiles
  for select using (public.is_org_member(org_id));
drop policy if exists user_profiles_insert_self on public.user_profiles;
create policy user_profiles_insert_self on public.user_profiles
  for insert with check (public.is_org_member(org_id) and user_id = auth.uid());
drop policy if exists user_profiles_update_self on public.user_profiles;
create policy user_profiles_update_self on public.user_profiles
  for update using (public.is_org_member(org_id) and user_id = auth.uid())
  with check (public.is_org_member(org_id) and user_id = auth.uid());
drop policy if exists user_profiles_delete_self on public.user_profiles;
create policy user_profiles_delete_self on public.user_profiles
  for delete using (public.is_org_member(org_id) and user_id = auth.uid());

drop policy if exists ai_execution_logs_select_member on public.ai_execution_logs;
create policy ai_execution_logs_select_member on public.ai_execution_logs
  for select using (public.is_org_member(org_id));
drop policy if exists ai_execution_logs_insert_member on public.ai_execution_logs;
create policy ai_execution_logs_insert_member on public.ai_execution_logs
  for insert with check (public.is_org_member(org_id));
drop policy if exists ai_execution_logs_update_member on public.ai_execution_logs;
create policy ai_execution_logs_update_member on public.ai_execution_logs
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists ai_execution_logs_delete_member on public.ai_execution_logs;
create policy ai_execution_logs_delete_member on public.ai_execution_logs
  for delete using (public.is_org_member(org_id));

-- extend session policies for channel scope
 drop policy if exists chat_sessions_select_accessible on public.chat_sessions;
create policy chat_sessions_select_accessible on public.chat_sessions
  for select using (
    public.is_org_member(org_id)
    and (
      scope = 'shared'
      or (scope = 'personal' and owner_user_id = auth.uid())
      or (scope = 'channel' and channel_id is not null and public.is_chat_channel_member(channel_id))
    )
  );

drop policy if exists chat_sessions_insert_accessible on public.chat_sessions;
create policy chat_sessions_insert_accessible on public.chat_sessions
  for insert with check (
    public.is_org_member(org_id)
    and (
      (scope = 'shared' and owner_user_id is null and channel_id is null)
      or (scope = 'personal' and owner_user_id = auth.uid() and channel_id is null)
      or (scope = 'channel' and owner_user_id is null and channel_id is not null and public.is_chat_channel_member(channel_id))
    )
  );

drop policy if exists chat_sessions_update_accessible on public.chat_sessions;
create policy chat_sessions_update_accessible on public.chat_sessions
  for update using (
    public.is_org_member(org_id)
    and (
      scope = 'shared'
      or (scope = 'personal' and owner_user_id = auth.uid())
      or (scope = 'channel' and channel_id is not null and public.is_chat_channel_member(channel_id))
    )
  )
  with check (
    public.is_org_member(org_id)
    and (
      scope = 'shared'
      or (scope = 'personal' and owner_user_id = auth.uid())
      or (scope = 'channel' and channel_id is not null and public.is_chat_channel_member(channel_id))
    )
  );

drop policy if exists chat_sessions_delete_accessible on public.chat_sessions;
create policy chat_sessions_delete_accessible on public.chat_sessions
  for delete using (
    public.is_org_member(org_id)
    and (
      scope = 'shared'
      or (scope = 'personal' and owner_user_id = auth.uid())
      or (scope = 'channel' and channel_id is not null and public.is_chat_channel_member(channel_id))
    )
  );

commit;
