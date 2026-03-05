begin;

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  scope text not null check (scope in ('shared', 'personal')),
  owner_user_id uuid references auth.users(id) on delete set null,
  title text not null default 'chat',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists chat_sessions_org_shared_unique
  on public.chat_sessions (org_id)
  where scope = 'shared';

create unique index if not exists chat_sessions_org_owner_personal_unique
  on public.chat_sessions (org_id, owner_user_id)
  where scope = 'personal';

create index if not exists idx_chat_sessions_org_updated
  on public.chat_sessions (org_id, updated_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  sender_type public.actor_type_enum not null,
  sender_user_id uuid references auth.users(id) on delete set null,
  body_text text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_chat_messages_session_created
  on public.chat_messages (session_id, created_at asc);
create index if not exists idx_chat_messages_org_created
  on public.chat_messages (org_id, created_at desc);

create table if not exists public.chat_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  intent_type text not null,
  confidence numeric not null default 0,
  intent_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_chat_intents_org_created
  on public.chat_intents (org_id, created_at desc);
create index if not exists idx_chat_intents_message
  on public.chat_intents (message_id);

create table if not exists public.chat_confirmations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  intent_id uuid not null references public.chat_intents(id) on delete cascade,
  status text not null check (status in ('pending', 'confirmed', 'declined', 'expired')),
  expires_at timestamptz not null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_chat_confirmations_org_status_created
  on public.chat_confirmations (org_id, status, created_at desc);
create index if not exists idx_chat_confirmations_session_status
  on public.chat_confirmations (session_id, status, created_at desc);

create table if not exists public.chat_commands (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  intent_id uuid not null references public.chat_intents(id) on delete cascade,
  execution_status text not null check (execution_status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  execution_ref_type text,
  execution_ref_id uuid,
  result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz
);

create index if not exists idx_chat_commands_org_status_created
  on public.chat_commands (org_id, execution_status, created_at desc);
create index if not exists idx_chat_commands_session_created
  on public.chat_commands (session_id, created_at desc);

grant select, insert, update, delete on public.chat_sessions to authenticated, service_role;
grant select, insert, update, delete on public.chat_messages to authenticated, service_role;
grant select, insert, update, delete on public.chat_intents to authenticated, service_role;
grant select, insert, update, delete on public.chat_confirmations to authenticated, service_role;
grant select, insert, update, delete on public.chat_commands to authenticated, service_role;

alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_intents enable row level security;
alter table public.chat_confirmations enable row level security;
alter table public.chat_commands enable row level security;

drop policy if exists chat_sessions_select_member on public.chat_sessions;
create policy chat_sessions_select_member on public.chat_sessions
  for select using (public.is_org_member(org_id));
drop policy if exists chat_sessions_insert_member on public.chat_sessions;
create policy chat_sessions_insert_member on public.chat_sessions
  for insert with check (public.is_org_member(org_id));
drop policy if exists chat_sessions_update_member on public.chat_sessions;
create policy chat_sessions_update_member on public.chat_sessions
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists chat_sessions_delete_member on public.chat_sessions;
create policy chat_sessions_delete_member on public.chat_sessions
  for delete using (public.is_org_member(org_id));

drop policy if exists chat_messages_select_member on public.chat_messages;
create policy chat_messages_select_member on public.chat_messages
  for select using (public.is_org_member(org_id));
drop policy if exists chat_messages_insert_member on public.chat_messages;
create policy chat_messages_insert_member on public.chat_messages
  for insert with check (public.is_org_member(org_id));
drop policy if exists chat_messages_update_member on public.chat_messages;
create policy chat_messages_update_member on public.chat_messages
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists chat_messages_delete_member on public.chat_messages;
create policy chat_messages_delete_member on public.chat_messages
  for delete using (public.is_org_member(org_id));

drop policy if exists chat_intents_select_member on public.chat_intents;
create policy chat_intents_select_member on public.chat_intents
  for select using (public.is_org_member(org_id));
drop policy if exists chat_intents_insert_member on public.chat_intents;
create policy chat_intents_insert_member on public.chat_intents
  for insert with check (public.is_org_member(org_id));
drop policy if exists chat_intents_update_member on public.chat_intents;
create policy chat_intents_update_member on public.chat_intents
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists chat_intents_delete_member on public.chat_intents;
create policy chat_intents_delete_member on public.chat_intents
  for delete using (public.is_org_member(org_id));

drop policy if exists chat_confirmations_select_member on public.chat_confirmations;
create policy chat_confirmations_select_member on public.chat_confirmations
  for select using (public.is_org_member(org_id));
drop policy if exists chat_confirmations_insert_member on public.chat_confirmations;
create policy chat_confirmations_insert_member on public.chat_confirmations
  for insert with check (public.is_org_member(org_id));
drop policy if exists chat_confirmations_update_member on public.chat_confirmations;
create policy chat_confirmations_update_member on public.chat_confirmations
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists chat_confirmations_delete_member on public.chat_confirmations;
create policy chat_confirmations_delete_member on public.chat_confirmations
  for delete using (public.is_org_member(org_id));

drop policy if exists chat_commands_select_member on public.chat_commands;
create policy chat_commands_select_member on public.chat_commands
  for select using (public.is_org_member(org_id));
drop policy if exists chat_commands_insert_member on public.chat_commands;
create policy chat_commands_insert_member on public.chat_commands
  for insert with check (public.is_org_member(org_id));
drop policy if exists chat_commands_update_member on public.chat_commands;
create policy chat_commands_update_member on public.chat_commands
  for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists chat_commands_delete_member on public.chat_commands;
create policy chat_commands_delete_member on public.chat_commands
  for delete using (public.is_org_member(org_id));

commit;
