alter table if exists public.business_cases
  add column if not exists owner_user_id uuid,
  add column if not exists due_at timestamptz;

create index if not exists idx_business_cases_org_owner_updated_at
  on public.business_cases (org_id, owner_user_id, updated_at desc);

create index if not exists idx_business_cases_org_due_at
  on public.business_cases (org_id, due_at);
