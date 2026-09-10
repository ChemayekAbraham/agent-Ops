-- Machine (service-role) path for the ENGREP harvest register.
-- Index guards skipped: engrep_windows_period_key, engrep_rows_evidence_uk and
-- engrep_unclaimed_uk already cover the requested columns. Nothing dropped.

create or replace function public.engrep_svc_ensure_window(p_granularity text, p_day date)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_end date;
begin
  if p_granularity not in ('day','week','month') then
    raise exception 'engrep: granularity must be day, week or month';
  end if;
  v_end := case p_granularity
             when 'day'   then p_day
             when 'week'  then p_day + 6
             when 'month' then (date_trunc('month', p_day) + interval '1 month - 1 day')::date
           end;
  insert into public.engrep_windows (granularity, period_start, period_end)
  values (p_granularity, p_day, v_end)
  on conflict (granularity, period_start) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.engrep_windows
     where granularity = p_granularity and period_start = p_day;
  end if;
  return v_id;
end $function$;

create or replace function public.engrep_svc_ingest_row(p_window_id uuid, p_source text, p_evidence_ref text, p_commit_subject text, p_change_classes text[] DEFAULT '{}'::text[], p_engineer_code text DEFAULT NULL::text, p_author_email text DEFAULT NULL::text, p_claims_schema boolean DEFAULT false, p_migration_bearing boolean DEFAULT false, p_untagged boolean DEFAULT false, p_fenced_breach boolean DEFAULT false, p_fence_path text DEFAULT NULL::text, p_self_fix boolean DEFAULT false, p_self_fix_of uuid DEFAULT NULL::uuid, p_claimed_objects text[] DEFAULT '{}'::text[])
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid; v_status text; v_eng uuid; v_kind text; v_live text;
  v_end date; v_missing integer;
begin
  select status, period_end into v_status, v_end
    from public.engrep_windows where id = p_window_id;
  if v_status is null then raise exception 'engrep: no such window'; end if;
  if v_status = 'locked' then raise exception 'engrep: window is locked'; end if;

  v_kind := case when p_source = 'lovable_edit' then 'message_id' else 'sha' end;

  if p_engineer_code is not null then
    select id into v_eng from public.engrep_engineers where code = upper(p_engineer_code);
  elsif p_author_email is not null then
    select id into v_eng from public.engrep_engineers
     where p_author_email = any(git_emails) limit 1;
  end if;

  if not p_claims_schema then
    v_live := 'na';
  else
    select count(*) into v_missing
    from unnest(p_claimed_objects) as claimed(object_key)
    where not exists (
      select 1 from public.engrep_catalog_delta(v_end) d
      where d.object_key = claimed.object_key
    );
    v_live := case when v_missing = 0 then 'yes' else 'no' end;
  end if;

  insert into public.engrep_rows (
    window_id, source, engineer_code, engineer_id, author_email,
    evidence_kind, evidence_ref, commit_subject, change_classes,
    claims_schema, migration_bearing, live_verified,
    untagged, fenced_breach, fence_path, self_fix, self_fix_of, claimed_objects)
  values (
    p_window_id, p_source, upper(p_engineer_code), v_eng, p_author_email,
    v_kind, p_evidence_ref, p_commit_subject, p_change_classes,
    p_claims_schema, p_migration_bearing, v_live,
    p_untagged, p_fenced_breach, p_fence_path, p_self_fix, p_self_fix_of,
    coalesce(p_claimed_objects,'{}'))
  on conflict (window_id, source, evidence_ref) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.engrep_rows
     where window_id = p_window_id and source = p_source and evidence_ref = p_evidence_ref;
  end if;
  return v_id;
end $function$;

create or replace function public.engrep_svc_detect_unclaimed(p_window_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_end date; v_n integer;
begin
  select period_end into v_end from public.engrep_windows where id = p_window_id;
  if v_end is null then raise exception 'engrep: no such window'; end if;

  insert into public.engrep_unclaimed_objects (window_id, object_kind, object_key, change)
  select p_window_id, d.object_kind, d.object_key, d.change
  from public.engrep_catalog_delta(v_end) d
  where not exists (
    select 1 from public.engrep_rows r
    where r.window_id = p_window_id
      and d.object_key = any(r.claimed_objects)
  )
  on conflict (window_id, object_kind, object_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

create or replace function public.engrep_svc_mark_harvested(p_window_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.engrep_windows set harvested_at = now()
   where id = p_window_id and status = 'open';
end $function$;

create or replace function public.engrep_resolve_claim(p_names text[], p_day date)
  returns text[] language sql stable security definer
  set search_path to 'public','pg_temp'
as $$
  select coalesce(array_agg(distinct resolved), '{}'::text[])
  from (
    select coalesce(
             ( select d.object_key from public.engrep_catalog_delta(p_day) d
               where d.object_key = n.name
                  or d.object_key like n.name || '(%'
                  or d.object_key like '%.' || n.name
               order by length(d.object_key) limit 1 ),
             n.name ) as resolved
    from unnest(p_names) as n(name)
  ) r
$$;

revoke all on function public.engrep_svc_ensure_window(text, date) from public, anon, authenticated;
grant execute on function public.engrep_svc_ensure_window(text, date) to service_role;

revoke all on function public.engrep_svc_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[]) from public, anon, authenticated;
grant execute on function public.engrep_svc_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[]) to service_role;

revoke all on function public.engrep_svc_detect_unclaimed(uuid) from public, anon, authenticated;
grant execute on function public.engrep_svc_detect_unclaimed(uuid) to service_role;

revoke all on function public.engrep_svc_mark_harvested(uuid) from public, anon, authenticated;
grant execute on function public.engrep_svc_mark_harvested(uuid) to service_role;

revoke all on function public.engrep_resolve_claim(text[], date) from public, anon, authenticated;
grant execute on function public.engrep_resolve_claim(text[], date) to service_role;

select cron.schedule(
  'engrep-harvest-commits-1705-eat',
  '5 14 * * *',
  $cron$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/engrep-harvest-commits',
    headers:='{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:=concat('{"time": "', now(), '"}')::jsonb
  ) as request_id;
  $cron$
);

select cron.schedule(
  'engrep-week-window-mon-1715-eat',
  '15 14 * * 1',
  $cron$
  select public.engrep_svc_ensure_window('week',
    ((now() at time zone 'Africa/Kampala')::date - 7));
  $cron$
);

select cron.schedule(
  'engrep-month-window-1st-1720-eat',
  '20 14 1 * *',
  $cron$
  select public.engrep_svc_ensure_window('month',
    (date_trunc('month', (now() at time zone 'Africa/Kampala')::date
     - interval '1 month'))::date);
  $cron$
);