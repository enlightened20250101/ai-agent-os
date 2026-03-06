begin;

alter table if exists public.user_profiles
  add column if not exists job_title text;

create index if not exists idx_user_profiles_org_job_title
  on public.user_profiles (org_id, job_title);

commit;
