begin;

alter table public.org_autonomy_settings
  add column if not exists enforce_initiator_approver_separation boolean not null default false;

commit;
