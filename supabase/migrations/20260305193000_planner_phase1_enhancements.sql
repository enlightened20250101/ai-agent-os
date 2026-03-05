-- Phase 1 proposal triage enhancements.
alter table public.task_proposals
  add column if not exists planner_run_id uuid references public.planner_runs(id) on delete set null,
  add column if not exists priority_score numeric not null default 0,
  add column if not exists estimated_impact_json jsonb not null default '{}'::jsonb,
  add column if not exists decision_reason text;

alter table public.task_proposals
  drop constraint if exists task_proposals_priority_score_range;

alter table public.task_proposals
  add constraint task_proposals_priority_score_range
  check (priority_score >= 0 and priority_score <= 100);

create index if not exists task_proposals_org_status_priority_created_idx
  on public.task_proposals (org_id, status, priority_score desc, created_at desc);

create index if not exists task_proposals_planner_run_idx
  on public.task_proposals (planner_run_id);
