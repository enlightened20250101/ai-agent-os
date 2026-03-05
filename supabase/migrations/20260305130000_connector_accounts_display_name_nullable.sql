begin;

alter table public.connector_accounts
  alter column display_name drop not null;

commit;
