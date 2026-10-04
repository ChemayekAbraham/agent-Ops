create table if not exists public.report_archive (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_label text not null,
  granularity text not null,
  period_start date not null,
  period_end date not null,
  title text not null,
  summary text,
  payload jsonb not null,
  source_ref uuid,
  submitted_by uuid,
  submitted_by_name text,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='report_archive_granularity_chk') then
    alter table public.report_archive
      add constraint report_archive_granularity_chk
      check (granularity in ('day','week','month','ad_hoc'));
  end if;
end $$;

create unique index if not exists report_archive_unique_period
  on public.report_archive (source, granularity, period_start, coalesce(source_ref, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists report_archive_submitted_at_idx
  on public.report_archive (submitted_at desc);

create index if not exists report_archive_day_idx
  on public.report_archive (((submitted_at at time zone 'Africa/Kampala')::date) desc);

create index if not exists report_archive_source_period_idx
  on public.report_archive (source, period_start desc);

comment on table public.report_archive is
  'Retained copies of submitted reports from any module. One row per submitted report, holding the full rendered payload so it can be reopened and downloaded later exactly as it was submitted. Append and correct only: never delete a row to make a figure look different.';

alter table public.report_archive enable row level security;

create policy "Management and HR can read archived reports"
on public.report_archive for select to authenticated
using (
  has_role(auth.uid(), 'super_admin') or has_role(auth.uid(), 'manager')
  or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
  or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'cto')
  or has_role(auth.uid(), 'hr') or has_role(auth.uid(), 'operations')
  or has_role(auth.uid(), 'agent_ops') or has_role(auth.uid(), 'tenant_ops')
);

create policy "Reporting roles can archive a report"
on public.report_archive for insert to authenticated
with check (
  has_role(auth.uid(), 'super_admin') or has_role(auth.uid(), 'manager')
  or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
  or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
  or has_role(auth.uid(), 'agent_ops') or has_role(auth.uid(), 'tenant_ops')
);

create or replace function public.archive_report(
  p_source text,
  p_source_label text,
  p_granularity text,
  p_period_start date,
  p_period_end date,
  p_title text,
  p_payload jsonb,
  p_summary text default null,
  p_source_ref uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_id uuid;
begin
  if not (
    has_role(v_uid, 'super_admin') or has_role(v_uid, 'manager')
    or has_role(v_uid, 'ceo') or has_role(v_uid, 'coo')
    or has_role(v_uid, 'cfo') or has_role(v_uid, 'operations')
    or has_role(v_uid, 'agent_ops') or has_role(v_uid, 'tenant_ops')
  ) then
    raise exception 'not authorized';
  end if;

  if p_payload is null then
    raise exception 'archive_report: payload is required';
  end if;

  select nullif(btrim(coalesce(p.full_name, '')), '') into v_name
  from public.profiles p where p.id = v_uid;

  insert into public.report_archive (
    source, source_label, granularity, period_start, period_end,
    title, summary, payload, source_ref, submitted_by, submitted_by_name, submitted_at
  ) values (
    p_source, p_source_label, p_granularity, p_period_start, p_period_end,
    p_title, p_summary, p_payload, p_source_ref, v_uid, coalesce(v_name, 'Unknown'), now()
  )
  on conflict (source, granularity, period_start, coalesce(source_ref, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set
    payload = excluded.payload,
    title = excluded.title,
    summary = excluded.summary,
    period_end = excluded.period_end,
    submitted_by = excluded.submitted_by,
    submitted_by_name = excluded.submitted_by_name,
    submitted_at = excluded.submitted_at
  returning id into v_id;

  return v_id;
end;
$function$;

comment on function public.archive_report(text, text, text, date, date, text, jsonb, text, uuid) is
  'Writes a finished report into public.report_archive and returns its id. Re-submitting the same period for the same source replaces the stored copy rather than creating a duplicate. Records who submitted it and when.';