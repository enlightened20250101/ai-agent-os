begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.actions
  add column if not exists idempotency_key text;

update public.actions
set idempotency_key = encode(
  extensions.digest(
    convert_to(
      concat_ws(
        '|',
        task_id::text,
        provider::text,
        action_type,
        coalesce(request_json->>'to', ''),
        coalesce(request_json->>'subject', ''),
        coalesce(request_json->>'body_text', coalesce(request_json::text, ''))
      ),
      'UTF8'
    ),
    'sha256'
  ),
  'hex'
)
where idempotency_key is null;

with duplicates as (
  select
    id,
    row_number() over (
      partition by org_id, idempotency_key
      order by created_at asc, id asc
    ) as rn
  from public.actions
)
update public.actions a
set idempotency_key = a.idempotency_key || ':' || a.id::text
from duplicates d
where a.id = d.id
  and d.rn > 1;

alter table public.actions
  alter column idempotency_key set not null;

create unique index if not exists idx_actions_org_idempotency_key
  on public.actions (org_id, idempotency_key);

create unique index if not exists idx_actions_task_running_unique
  on public.actions (task_id)
  where status = 'running';

commit;
