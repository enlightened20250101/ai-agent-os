begin;

alter table public.exception_cases
  add column if not exists due_at timestamptz,
  add column if not exists last_alerted_at timestamptz;

create index if not exists idx_exception_cases_org_due_at
  on public.exception_cases (org_id, due_at)
  where due_at is not null and status <> 'resolved';

create index if not exists idx_exception_cases_org_last_alerted_at
  on public.exception_cases (org_id, last_alerted_at desc);

commit;
