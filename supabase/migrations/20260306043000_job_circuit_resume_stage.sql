begin;

alter table public.org_job_circuit_breakers
  add column if not exists resume_stage text not null default 'active'
    check (resume_stage in ('active', 'paused', 'dry_run')),
  add column if not exists dry_run_until timestamptz,
  add column if not exists last_opened_at timestamptz,
  add column if not exists manual_cleared_at timestamptz;

create index if not exists idx_org_job_circuit_breakers_org_stage
  on public.org_job_circuit_breakers (org_id, resume_stage, updated_at desc);

commit;
