begin;

create table if not exists public.org_autonomy_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  autonomy_level text not null default 'L1' check (autonomy_level in ('L0', 'L1', 'L2', 'L3', 'L4')),
  auto_execute_google_send_email boolean not null default false,
  max_auto_execute_risk_score integer not null default 25 check (max_auto_execute_risk_score between 0 and 100),
  min_trust_score integer not null default 80 check (min_trust_score between 0 and 100),
  daily_send_email_limit integer not null default 20 check (daily_send_email_limit >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint org_autonomy_settings_org_id_key unique (org_id)
);

create table if not exists public.risk_assessments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  proposal_id uuid references public.task_proposals(id) on delete set null,
  action_fingerprint text not null,
  risk_score integer not null check (risk_score between 0 and 100),
  dimensions_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.trust_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider public.provider_enum,
  action_type text,
  agent_role_key text,
  score integer not null check (score between 0 and 100),
  sample_size integer not null default 0 check (sample_size >= 0),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.budget_limits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider public.provider_enum not null,
  action_type text not null,
  period text not null default 'daily' check (period in ('daily')),
  limit_count integer not null check (limit_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint budget_limits_org_provider_action_period_key unique (org_id, provider, action_type, period)
);

create table if not exists public.budget_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider public.provider_enum not null,
  action_type text not null,
  usage_date date not null,
  used_count integer not null default 0 check (used_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint budget_usage_org_provider_action_date_key unique (org_id, provider, action_type, usage_date)
);

create index if not exists idx_org_autonomy_settings_org on public.org_autonomy_settings (org_id);
create index if not exists idx_risk_assessments_org_created_at on public.risk_assessments (org_id, created_at desc);
create index if not exists idx_risk_assessments_task on public.risk_assessments (task_id, created_at desc);
create index if not exists idx_risk_assessments_fingerprint on public.risk_assessments (org_id, action_fingerprint, created_at desc);
create index if not exists idx_trust_scores_org_provider_action on public.trust_scores (org_id, provider, action_type, updated_at desc);
create index if not exists idx_budget_limits_org_provider_action on public.budget_limits (org_id, provider, action_type);
create index if not exists idx_budget_usage_org_provider_action_date on public.budget_usage (org_id, provider, action_type, usage_date desc);

grant select, insert, update, delete on public.org_autonomy_settings to authenticated, service_role;
grant select, insert, update, delete on public.risk_assessments to authenticated, service_role;
grant select, insert, update, delete on public.trust_scores to authenticated, service_role;
grant select, insert, update, delete on public.budget_limits to authenticated, service_role;
grant select, insert, update, delete on public.budget_usage to authenticated, service_role;

alter table public.org_autonomy_settings enable row level security;
alter table public.risk_assessments enable row level security;
alter table public.trust_scores enable row level security;
alter table public.budget_limits enable row level security;
alter table public.budget_usage enable row level security;

drop policy if exists org_autonomy_settings_select_member on public.org_autonomy_settings;
create policy org_autonomy_settings_select_member on public.org_autonomy_settings
  for select
  using (public.is_org_member(org_id));

drop policy if exists org_autonomy_settings_insert_member on public.org_autonomy_settings;
create policy org_autonomy_settings_insert_member on public.org_autonomy_settings
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists org_autonomy_settings_update_member on public.org_autonomy_settings;
create policy org_autonomy_settings_update_member on public.org_autonomy_settings
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists org_autonomy_settings_delete_member on public.org_autonomy_settings;
create policy org_autonomy_settings_delete_member on public.org_autonomy_settings
  for delete
  using (public.is_org_member(org_id));

drop policy if exists risk_assessments_select_member on public.risk_assessments;
create policy risk_assessments_select_member on public.risk_assessments
  for select
  using (public.is_org_member(org_id));

drop policy if exists risk_assessments_insert_member on public.risk_assessments;
create policy risk_assessments_insert_member on public.risk_assessments
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists risk_assessments_update_member on public.risk_assessments;
create policy risk_assessments_update_member on public.risk_assessments
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists risk_assessments_delete_member on public.risk_assessments;
create policy risk_assessments_delete_member on public.risk_assessments
  for delete
  using (public.is_org_member(org_id));

drop policy if exists trust_scores_select_member on public.trust_scores;
create policy trust_scores_select_member on public.trust_scores
  for select
  using (public.is_org_member(org_id));

drop policy if exists trust_scores_insert_member on public.trust_scores;
create policy trust_scores_insert_member on public.trust_scores
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists trust_scores_update_member on public.trust_scores;
create policy trust_scores_update_member on public.trust_scores
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists trust_scores_delete_member on public.trust_scores;
create policy trust_scores_delete_member on public.trust_scores
  for delete
  using (public.is_org_member(org_id));

drop policy if exists budget_limits_select_member on public.budget_limits;
create policy budget_limits_select_member on public.budget_limits
  for select
  using (public.is_org_member(org_id));

drop policy if exists budget_limits_insert_member on public.budget_limits;
create policy budget_limits_insert_member on public.budget_limits
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists budget_limits_update_member on public.budget_limits;
create policy budget_limits_update_member on public.budget_limits
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists budget_limits_delete_member on public.budget_limits;
create policy budget_limits_delete_member on public.budget_limits
  for delete
  using (public.is_org_member(org_id));

drop policy if exists budget_usage_select_member on public.budget_usage;
create policy budget_usage_select_member on public.budget_usage
  for select
  using (public.is_org_member(org_id));

drop policy if exists budget_usage_insert_member on public.budget_usage;
create policy budget_usage_insert_member on public.budget_usage
  for insert
  with check (public.is_org_member(org_id));

drop policy if exists budget_usage_update_member on public.budget_usage;
create policy budget_usage_update_member on public.budget_usage
  for update
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists budget_usage_delete_member on public.budget_usage;
create policy budget_usage_delete_member on public.budget_usage
  for delete
  using (public.is_org_member(org_id));

commit;
