begin;

do $$
begin
  if to_regclass('public.external_events') is null then
    return;
  end if;

  alter table public.external_events
    add column if not exists priority text not null default 'normal'
      check (priority in ('low', 'normal', 'high', 'urgent'));

  alter table public.external_events
    add column if not exists triage_note text;

  alter table public.external_events
    add column if not exists triaged_at timestamptz;

  create index if not exists idx_external_events_org_priority_created_at
    on public.external_events (org_id, priority, created_at desc);
end
$$;

commit;
