alter table public.engrep_rows
  add column if not exists claimed_objects text[] not null default '{}';

alter table public.engrep_rows
  drop constraint if exists engrep_rows_claim_objects;
alter table public.engrep_rows
  add constraint engrep_rows_claim_objects
    check ((not claims_schema) or cardinality(claimed_objects) > 0);

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
  p_self_fix_of uuid default null,
  p_claimed_objects text[] default '{}')
returns uuid language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare
  v_id uuid; v_status text; v_eng uuid; v_kind text; v_live text;
  v_end date; v_missing integer;
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
    -- every object this row claims must appear in this window's catalog delta.
    -- one missing object means the change did not reach the database.
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
end $fn$;

create or replace function public.engrep_detect_unclaimed(p_window_id uuid)
returns integer language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare v_end date; v_n integer;
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may run detection';
  end if;
  select period_end into v_end from public.engrep_windows where id = p_window_id;
  if v_end is null then raise exception 'engrep: no such window'; end if;

  insert into public.engrep_unclaimed_objects (window_id, object_kind, object_key, change)
  select p_window_id, d.object_kind, d.object_key, d.change
  from public.engrep_catalog_delta(v_end) d
  where not exists (
    -- correlated: this specific object claimed by some row in this window
    select 1 from public.engrep_rows r
    where r.window_id = p_window_id
      and d.object_key = any(r.claimed_objects)
  )
  on conflict (window_id, object_kind, object_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;