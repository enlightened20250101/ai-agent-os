begin;

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
      and (s.scope = 'shared' or s.owner_user_id = auth.uid())
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
      and (s.scope = 'shared' or s.owner_user_id = auth.uid())
  );
$$;

grant execute on function public.is_chat_session_accessible(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_chat_message_accessible(uuid, uuid) to authenticated, service_role;

drop policy if exists chat_sessions_select_member on public.chat_sessions;
create policy chat_sessions_select_accessible on public.chat_sessions
  for select using (
    public.is_org_member(org_id)
    and (scope = 'shared' or owner_user_id = auth.uid())
  );

drop policy if exists chat_sessions_insert_member on public.chat_sessions;
create policy chat_sessions_insert_accessible on public.chat_sessions
  for insert with check (
    public.is_org_member(org_id)
    and (
      (scope = 'shared' and owner_user_id is null)
      or (scope = 'personal' and owner_user_id = auth.uid())
    )
  );

drop policy if exists chat_sessions_update_member on public.chat_sessions;
create policy chat_sessions_update_accessible on public.chat_sessions
  for update using (
    public.is_org_member(org_id)
    and (scope = 'shared' or owner_user_id = auth.uid())
  )
  with check (
    public.is_org_member(org_id)
    and (scope = 'shared' or owner_user_id = auth.uid())
  );

drop policy if exists chat_sessions_delete_member on public.chat_sessions;
create policy chat_sessions_delete_accessible on public.chat_sessions
  for delete using (
    public.is_org_member(org_id)
    and (scope = 'shared' or owner_user_id = auth.uid())
  );

drop policy if exists chat_messages_select_member on public.chat_messages;
create policy chat_messages_select_accessible on public.chat_messages
  for select using (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_messages_insert_member on public.chat_messages;
create policy chat_messages_insert_accessible on public.chat_messages
  for insert with check (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_messages_update_member on public.chat_messages;
create policy chat_messages_update_accessible on public.chat_messages
  for update using (public.is_chat_session_accessible(org_id, session_id))
  with check (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_messages_delete_member on public.chat_messages;
create policy chat_messages_delete_accessible on public.chat_messages
  for delete using (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_intents_select_member on public.chat_intents;
create policy chat_intents_select_accessible on public.chat_intents
  for select using (public.is_chat_message_accessible(org_id, message_id));

drop policy if exists chat_intents_insert_member on public.chat_intents;
create policy chat_intents_insert_accessible on public.chat_intents
  for insert with check (public.is_chat_message_accessible(org_id, message_id));

drop policy if exists chat_intents_update_member on public.chat_intents;
create policy chat_intents_update_accessible on public.chat_intents
  for update using (public.is_chat_message_accessible(org_id, message_id))
  with check (public.is_chat_message_accessible(org_id, message_id));

drop policy if exists chat_intents_delete_member on public.chat_intents;
create policy chat_intents_delete_accessible on public.chat_intents
  for delete using (public.is_chat_message_accessible(org_id, message_id));

drop policy if exists chat_confirmations_select_member on public.chat_confirmations;
create policy chat_confirmations_select_accessible on public.chat_confirmations
  for select using (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_confirmations_insert_member on public.chat_confirmations;
create policy chat_confirmations_insert_accessible on public.chat_confirmations
  for insert with check (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_confirmations_update_member on public.chat_confirmations;
create policy chat_confirmations_update_accessible on public.chat_confirmations
  for update using (public.is_chat_session_accessible(org_id, session_id))
  with check (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_confirmations_delete_member on public.chat_confirmations;
create policy chat_confirmations_delete_accessible on public.chat_confirmations
  for delete using (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_commands_select_member on public.chat_commands;
create policy chat_commands_select_accessible on public.chat_commands
  for select using (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_commands_insert_member on public.chat_commands;
create policy chat_commands_insert_accessible on public.chat_commands
  for insert with check (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_commands_update_member on public.chat_commands;
create policy chat_commands_update_accessible on public.chat_commands
  for update using (public.is_chat_session_accessible(org_id, session_id))
  with check (public.is_chat_session_accessible(org_id, session_id));

drop policy if exists chat_commands_delete_member on public.chat_commands;
create policy chat_commands_delete_accessible on public.chat_commands
  for delete using (public.is_chat_session_accessible(org_id, session_id));

commit;
