create or replace function public.get_voice_call_log(
  p_search text default null,
  p_status text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 15,
  p_offset integer default 0
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_rows jsonb; v_total bigint; v_status text; v_search text;
begin
  if not public.voice_call_log_authorized(auth.uid()) then
    raise exception 'not_authorized';
  end if;

  v_status := nullif(replace(lower(btrim(coalesce(p_status,''))), '_', ''), '');
  if v_status = 'all' then v_status := null; end if;
  v_search := nullif(btrim(coalesce(p_search,'')), '');

  with base as (
    select s.*, sp.full_name as staff_full_name
    from public.crm_call_sessions s
    left join public.profiles sp on sp.id = s.staff_id
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (
        v_status is null
        or replace(lower(coalesce(s.status,'')), '_', '') = v_status
        or (v_status in ('noanswer','notanswered') and replace(lower(coalesce(s.status,'')), '_', '') in ('notanswered','noanswer'))
      )
      and (
        v_search is null or
        coalesce(s.target_name,'') ilike '%'||v_search||'%' or
        coalesce(s.target_phone,'') ilike '%'||v_search||'%' or
        coalesce(s.staff_phone,'') ilike '%'||v_search||'%' or
        coalesce(sp.full_name,'') ilike '%'||v_search||'%' or
        coalesce(s.target_role,'') ilike '%'||v_search||'%' or
        coalesce(s.at_session_id,'') ilike '%'||v_search||'%' or
        coalesce(s.status,'') ilike '%'||v_search||'%' or
        coalesce(s.hangup_cause,'') ilike '%'||v_search||'%' or
        coalesce(s.failure_reason,'') ilike '%'||v_search||'%'
      )
  )
  select count(*) into v_total from base;

  with base as (
    select s.*, sp.full_name as staff_full_name
    from public.crm_call_sessions s
    left join public.profiles sp on sp.id = s.staff_id
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (
        v_status is null
        or replace(lower(coalesce(s.status,'')), '_', '') = v_status
        or (v_status in ('noanswer','notanswered') and replace(lower(coalesce(s.status,'')), '_', '') in ('notanswered','noanswer'))
      )
      and (
        v_search is null or
        coalesce(s.target_name,'') ilike '%'||v_search||'%' or
        coalesce(s.target_phone,'') ilike '%'||v_search||'%' or
        coalesce(s.staff_phone,'') ilike '%'||v_search||'%' or
        coalesce(sp.full_name,'') ilike '%'||v_search||'%' or
        coalesce(s.target_role,'') ilike '%'||v_search||'%' or
        coalesce(s.at_session_id,'') ilike '%'||v_search||'%' or
        coalesce(s.status,'') ilike '%'||v_search||'%' or
        coalesce(s.hangup_cause,'') ilike '%'||v_search||'%' or
        coalesce(s.failure_reason,'') ilike '%'||v_search||'%'
      )
    order by s.created_at desc
    limit greatest(1, least(coalesce(p_limit,15), 100))
    offset greatest(0, coalesce(p_offset,0))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id,
    'created_at', b.created_at,
    'answered_at', b.answered_at,
    'ended_at', b.ended_at,
    'at_session_id', b.at_session_id,
    'staff_name', b.staff_full_name,
    'staff_phone', b.staff_phone,
    'target_name', b.target_name,
    'target_phone', b.target_phone,
    'target_role', b.target_role,
    'target_location', b.target_location,
    'direction', b.direction,
    'transport', b.transport,
    'status', b.status,
    'hangup_cause', b.hangup_cause,
    'failure_reason', b.failure_reason,
    'duration_seconds', b.duration_seconds,
    'cost_amount', b.cost_amount,
    'cost_currency', b.cost_currency,
    'is_active', b.is_active,
    'recording_url', b.recording_url
  ) order by b.created_at desc), '[]'::jsonb)
  into v_rows
  from base b;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;