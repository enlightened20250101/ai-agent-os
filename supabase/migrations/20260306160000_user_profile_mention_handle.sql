begin;

alter table if exists public.user_profiles
  add column if not exists mention_handle text;

create unique index if not exists user_profiles_org_mention_handle_unique
  on public.user_profiles (org_id, lower(mention_handle))
  where mention_handle is not null;

with base as (
  select id, org_id, user_id,
    coalesce(nullif(regexp_replace(lower(coalesce(display_name, '')), '[^a-z0-9_]+', '_', 'g'), ''), substring(user_id::text from 1 for 8)) as h
  from public.user_profiles
), ranked as (
  select id, case when row_number() over (partition by org_id, h order by id) = 1 then h else h || '_' || row_number() over (partition by org_id, h order by id)::text end as final_h
  from base
)
update public.user_profiles p
set mention_handle = r.final_h
from ranked r
where p.id = r.id
  and (p.mention_handle is null or p.mention_handle = '');

commit;
