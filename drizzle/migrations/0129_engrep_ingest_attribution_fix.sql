CREATE OR REPLACE FUNCTION public.engrep_svc_ingest_row(p_window_id uuid, p_source text, p_evidence_ref text, p_commit_subject text, p_change_classes text[] DEFAULT '{}'::text[], p_engineer_code text DEFAULT NULL::text, p_author_email text DEFAULT NULL::text, p_claims_schema boolean DEFAULT false, p_migration_bearing boolean DEFAULT false, p_untagged boolean DEFAULT false, p_fenced_breach boolean DEFAULT false, p_fence_path text DEFAULT NULL::text, p_self_fix boolean DEFAULT false, p_self_fix_of uuid DEFAULT NULL::uuid, p_claimed_objects text[] DEFAULT '{}'::text[], p_paths text[] DEFAULT '{}'::text[], p_committed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid; v_status text; v_eng uuid; v_kind text; v_live text;
  v_end date; v_total integer; v_landed integer;
  v_attribution text; v_code text; v_untagged boolean;
begin
  select status, period_end into v_status, v_end
    from public.engrep_windows where id = p_window_id;
  if v_status is null then raise exception 'engrep: no such window'; end if;
  if v_status = 'locked' then raise exception 'engrep: window is locked'; end if;

  v_kind := case
    when p_source = 'lovable_edit' then
      case when p_evidence_ref ~ '^[0-9a-f]{7,40}$' then 'commit_sha' else 'message_id' end
    else 'sha' end;

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
  if v_attribution = 'none' and p_author_email is not null then
    select id, code into v_eng, v_code from public.engrep_engineers
     where active and p_author_email = any(git_emails) limit 1;
    if v_eng is not null then v_attribution := 'email'; end if;
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
    v_live := 'na'; v_total := null; v_landed := null;
  else
    -- partial credit: count how many claimed objects actually reached the
    -- catalog delta. A name resolving to several catalog keys counts once.
    v_total := coalesce(cardinality(p_claimed_objects), 0);
    select count(distinct claimed.object_key) into v_landed
    from unnest(p_claimed_objects) as claimed(object_key)
    where exists (
      select 1 from public.engrep_catalog_delta(v_end) d
      where d.object_key = claimed.object_key
         or d.object_key like claimed.object_key || '(%'
         or d.object_key like '%.' || claimed.object_key
         or d.object_key like claimed.object_key || '.%'
    );
    v_landed := coalesce(v_landed, 0);
    v_live := case
                when v_total = 0 then 'na'
                when v_landed = v_total then 'yes'
                when v_landed > 0 then 'part'
                else 'no' end;
  end if;

  insert into public.engrep_rows (
    window_id, source, engineer_code, engineer_id, author_email,
    evidence_kind, evidence_ref, commit_subject, change_classes,
    claims_schema, migration_bearing, live_verified, claims_total, claims_landed,
    untagged, fenced_breach, fence_path, self_fix, self_fix_of, claimed_objects,
    attribution, paths, committed_at)
  values (
    p_window_id, p_source, v_code, v_eng, p_author_email,
    v_kind, p_evidence_ref, p_commit_subject, p_change_classes,
    p_claims_schema, p_migration_bearing, v_live, v_total, v_landed,
    v_untagged, p_fenced_breach, p_fence_path, p_self_fix, p_self_fix_of,
    coalesce(p_claimed_objects,'{}'),
    v_attribution, p_paths, p_committed_at)
  on conflict (window_id, source, evidence_ref) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.engrep_rows
     where window_id = p_window_id and source = p_source and evidence_ref = p_evidence_ref;
  end if;
  return v_id;
end $function$;