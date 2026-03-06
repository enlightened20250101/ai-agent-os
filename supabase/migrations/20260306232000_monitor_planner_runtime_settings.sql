begin;

alter table public.org_autonomy_settings
  add column if not exists monitor_stale_hours integer not null default 6 check (monitor_stale_hours between 1 and 168),
  add column if not exists monitor_min_signal_score integer not null default 3 check (monitor_min_signal_score between 1 and 999),
  add column if not exists monitor_planner_cooldown_minutes integer not null default 30 check (monitor_planner_cooldown_minutes between 0 and 1440),
  add column if not exists planner_proposal_dedupe_hours integer not null default 24 check (planner_proposal_dedupe_hours between 1 and 336);

commit;
