alter table if exists public.business_cases
  add column if not exists stage text not null default 'intake';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'business_cases_stage_check'
      and conrelid = 'public.business_cases'::regclass
  ) then
    alter table public.business_cases
      add constraint business_cases_stage_check
      check (stage in ('intake','drafting','awaiting_approval','approved','executing','exception','blocked','completed'));
  end if;
end $$;

create index if not exists idx_business_cases_org_stage_updated_at
  on public.business_cases (org_id, stage, updated_at desc);

update public.business_cases
set stage = case
  when status = 'closed' then 'completed'
  when status = 'blocked' then 'blocked'
  else 'intake'
end
where stage is null or stage = '';
