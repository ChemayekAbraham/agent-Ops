alter table public.engrep_rows add column if not exists paths text[];

drop function public.engrep_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[]);
drop function public.engrep_svc_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[]);

create function public.engrep_ingest_row(p_window_id uuid, p_source text, p_evidence_ref text, p_commit_subject text, p_change_classes text[] default '{}'::text[], p_engineer_code text default null::text, p_author_email text default null::text, p_claims_schema boolean default false, p_migration_bearing boolean default false, p_untagged boolean default false, p_fenced_breach boolean default false, p_fence_path text default null::text, p_self_fix boolean default false, p_self_fix_of uuid default null::uuid, p_claimed_objects text[] default '{}'::text[], p_paths text[] default '{}'::text[])
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid; v_status text; v_eng uuid; v_kind text; v_live text;
  v_end date; v_missing integer;
  v_attribution text; v_code text; v_path_code text; v_untagged boolean;
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

  -- attribution resolution: first branch that hits wins.
  v_code := upper(p_engineer_code);
  v_attribution := 'none';
  if p_engineer_code is not null then
    select id, code into v_eng, v_code from public.engrep_engineers
     where code = upper(p_engineer_code) and active;
    if v_eng is not null then v_attribution := 'prefix'; end if;
  end if;
  if v_attribution = 'none' and p_source = 'external_commit' and p_author_email is not null then
    select id into v_eng from public.engrep_engineers
     where active and p_author_email = any(git_emails) limit 1;
    if v_eng is not null then v_attribution := 'email'; end if;
  end if;
  if v_attribution = 'none' and p_source = 'lovable_edit' and p_engineer_code is null then
    v_path_code := public.engrep_path_owner(p_paths, v_end);
    if v_path_code is not null then
      select id, code into v_eng, v_code from public.engrep_engineers
       where code = upper(v_path_code) and active;
      if v_eng is not null then v_attribution := 'declared_path'; end if;
    end if;
  end if;
  if v_attribution = 'none' then v_eng := null; v_code := upper(p_engineer_code); end if;

  if p_untagged then
    v_untagged := true;
  elsif p_source = 'lovable_edit' then
    v_untagged := (v_attribution = 'none');
  else
    v_untagged := p_untagged;
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
    untagged, fenced_breach, fence_path, self_fix, self_fix_of, claimed_objects,
    attribution, paths)
  values (
    p_window_id, p_source, v_code, v_eng, p_author_email,
    v_kind, p_evidence_ref, p_commit_subject, p_change_classes,
    p_claims_schema, p_migration_bearing, v_live,
    v_untagged, p_fenced_breach, p_fence_path, p_self_fix, p_self_fix_of,
    coalesce(p_claimed_objects,'{}'),
    v_attribution, p_paths)
  on conflict (window_id, source, evidence_ref) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.engrep_rows
     where window_id = p_window_id and source = p_source and evidence_ref = p_evidence_ref;
  end if;
  return v_id;
end $function$;

create function public.engrep_svc_ingest_row(p_window_id uuid, p_source text, p_evidence_ref text, p_commit_subject text, p_change_classes text[] default '{}'::text[], p_engineer_code text default null::text, p_author_email text default null::text, p_claims_schema boolean default false, p_migration_bearing boolean default false, p_untagged boolean default false, p_fenced_breach boolean default false, p_fence_path text default null::text, p_self_fix boolean default false, p_self_fix_of uuid default null::uuid, p_claimed_objects text[] default '{}'::text[], p_paths text[] default '{}'::text[])
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid; v_status text; v_eng uuid; v_kind text; v_live text;
  v_end date; v_missing integer;
  v_attribution text; v_code text; v_path_code text; v_untagged boolean;
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

  -- attribution resolution: first branch that hits wins.
  v_code := upper(p_engineer_code);
  v_attribution := 'none';
  if p_engineer_code is not null then
    select id, code into v_eng, v_code from public.engrep_engineers
     where code = upper(p_engineer_code) and active;
    if v_eng is not null then v_attribution := 'prefix'; end if;
  end if;
  if v_attribution = 'none' and p_source = 'external_commit' and p_author_email is not null then
    select id into v_eng from public.engrep_engineers
     where active and p_author_email = any(git_emails) limit 1;
    if v_eng is not null then v_attribution := 'email'; end if;
  end if;
  if v_attribution = 'none' and p_source = 'lovable_edit' and p_engineer_code is null then
    v_path_code := public.engrep_path_owner(p_paths, v_end);
    if v_path_code is not null then
      select id, code into v_eng, v_code from public.engrep_engineers
       where code = upper(v_path_code) and active;
      if v_eng is not null then v_attribution := 'declared_path'; end if;
    end if;
  end if;
  if v_attribution = 'none' then v_eng := null; v_code := upper(p_engineer_code); end if;

  if p_untagged then
    v_untagged := true;
  elsif p_source = 'lovable_edit' then
    v_untagged := (v_attribution = 'none');
  else
    v_untagged := p_untagged;
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
    untagged, fenced_breach, fence_path, self_fix, self_fix_of, claimed_objects,
    attribution, paths)
  values (
    p_window_id, p_source, v_code, v_eng, p_author_email,
    v_kind, p_evidence_ref, p_commit_subject, p_change_classes,
    p_claims_schema, p_migration_bearing, v_live,
    v_untagged, p_fenced_breach, p_fence_path, p_self_fix, p_self_fix_of,
    coalesce(p_claimed_objects,'{}'),
    v_attribution, p_paths)
  on conflict (window_id, source, evidence_ref) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.engrep_rows
     where window_id = p_window_id and source = p_source and evidence_ref = p_evidence_ref;
  end if;
  return v_id;
end $function$;

revoke all on function public.engrep_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[], text[]) from public, anon;
grant execute on function public.engrep_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[], text[]) to authenticated, service_role;

revoke all on function public.engrep_svc_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[], text[]) from public, anon, authenticated;
grant execute on function public.engrep_svc_ingest_row(uuid, text, text, text, text[], text, text, boolean, boolean, boolean, boolean, text, boolean, uuid, text[], text[]) to service_role;

notify pgrst, 'reload schema';