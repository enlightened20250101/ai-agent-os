begin;

do $$
begin
  if to_regclass('public.external_events') is null then
    return;
  end if;

  alter table public.external_events
    add column if not exists linked_case_id uuid references public.business_cases(id) on delete set null;

  create index if not exists idx_external_events_org_linked_case
    on public.external_events (org_id, linked_case_id);
end
$$;

commit;
