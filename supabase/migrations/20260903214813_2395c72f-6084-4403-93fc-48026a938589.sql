create or replace function public.engrep_open_window(
  p_granularity text, p_period_start date)
returns uuid language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare v_id uuid; v_end date;
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may open a window';
  end if;
  if p_granularity not in ('day','week','month') then
    raise exception 'engrep: granularity must be day, week or month';
  end if;
  v_end := case p_granularity
             when 'day'   then p_period_start
             when 'week'  then p_period_start + 6
             when 'month' then (date_trunc('month', p_period_start) + interval '1 month - 1 day')::date
           end;
  insert into public.engrep_windows (granularity, period_start, period_end)
  values (p_granularity, p_period_start, v_end)
  on conflict (granularity, period_start) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.engrep_windows
     where granularity = p_granularity and period_start = p_period_start;
  end if;
  return v_id;
end $fn$;

create or replace function public.engrep_ingest_row(
  p_window_id uuid,
  p_source text,
  p_evidence_ref text,
  p_commit_subject text,
  p_change_classes text[] default '{}',
  p_engineer_code text default null,
  p_author_email text default null,
  p_claims_schema boolean default false,
  p_migration_bearing boolean default false,
  p_untagged boolean default false,
  p_fenced_breach boolean default false,
  p_fence_path text default null,
  p_self_fix boolean default false,
  p_self_fix_of uuid default null)
returns uuid language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare
  v_id uuid; v_status text; v_eng uuid; v_kind text; v_live text; v_end date;
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may post a harvest row';
  end if;
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
    select case when exists (
             select 1 from public.engrep_catalog_delta(v_end) d
             where d.object_kind in ('table','column','function','trigger','policy','view','index')
           ) then 'yes' else 'no' end into v_live;
  end if;

  insert into public.engrep_rows (
    window_id, source, engineer_code, engineer_id, author_email,
    evidence_kind, evidence_ref, commit_subject, change_classes,
    claims_schema, migration_bearing, live_verified,
    untagged, fenced_breach, fence_path, self_fix, self_fix_of)
  values (
    p_window_id, p_source, upper(p_engineer_code), v_eng, p_author_email,
    v_kind, p_evidence_ref, p_commit_subject, p_change_classes,
    p_claims_schema, p_migration_bearing, v_live,
    p_untagged, p_fenced_breach, p_fence_path, p_self_fix, p_self_fix_of)
  on conflict (window_id, source, evidence_ref) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.engrep_rows
     where window_id = p_window_id and source = p_source and evidence_ref = p_evidence_ref;
  end if;
  return v_id;
end $fn$;

create or replace function public.engrep_set_liveness(p_row_id uuid, p_verdict text)
returns void language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may set liveness';
  end if;
  if p_verdict not in ('yes','no') then
    raise exception 'engrep: verdict must be yes or no';
  end if;
  update public.engrep_rows
     set live_verified = p_verdict
   where id = p_row_id and claims_schema;
  if not found then
    raise exception 'engrep: row not found, or does not claim schema effect';
  end if;
end $fn$;

create or replace function public.engrep_mark_harvested(p_window_id uuid)
returns void language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may mark a window harvested';
  end if;
  update public.engrep_windows set harvested_at = now()
   where id = p_window_id and status = 'open';
end $fn$;