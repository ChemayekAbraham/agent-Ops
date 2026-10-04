create or replace function public.voice_call_log_authorized(_user_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and enabled = true
      and role in ('cto','super_admin','manager','ceo','coo','crm','operations')
  );
$$;

create or replace function public.get_voice_call_log(
  p_search text default null,
  p_status text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 15,
  p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_rows jsonb; v_total bigint;
begin
  if not public.voice_call_log_authorized(auth.uid()) then
    raise exception 'not_authorized';
  end if;

  with base as (
    select * from public.crm_call_sessions s
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (p_status is null or p_status = 'all' or lower(coalesce(s.status,'')) = lower(p_status))
      and (
        p_search is null or btrim(p_search) = '' or
        coalesce(s.target_name,'') ilike '%'||p_search||'%' or
        coalesce(s.target_phone,'') ilike '%'||p_search||'%' or
        coalesce(s.staff_phone,'') ilike '%'||p_search||'%' or
        coalesce(s.target_role,'') ilike '%'||p_search||'%' or
        coalesce(s.at_session_id,'') ilike '%'||p_search||'%' or
        coalesce(s.hangup_cause,'') ilike '%'||p_search||'%' or
        coalesce(s.failure_reason,'') ilike '%'||p_search||'%'
      )
  )
  select count(*) into v_total from base;

  with base as (
    select * from public.crm_call_sessions s
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (p_status is null or p_status = 'all' or lower(coalesce(s.status,'')) = lower(p_status))
      and (
        p_search is null or btrim(p_search) = '' or
        coalesce(s.target_name,'') ilike '%'||p_search||'%' or
        coalesce(s.target_phone,'') ilike '%'||p_search||'%' or
        coalesce(s.staff_phone,'') ilike '%'||p_search||'%' or
        coalesce(s.target_role,'') ilike '%'||p_search||'%' or
        coalesce(s.at_session_id,'') ilike '%'||p_search||'%' or
        coalesce(s.hangup_cause,'') ilike '%'||p_search||'%' or
        coalesce(s.failure_reason,'') ilike '%'||p_search||'%'
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
    'staff_name', sp.full_name,
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
  from base b
  left join public.profiles sp on sp.id = b.staff_id;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;

create or replace function public.get_voice_call_stats(
  p_from timestamptz default null,
  p_to timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v jsonb; v_daily jsonb; v_status jsonb;
begin
  if not public.voice_call_log_authorized(auth.uid()) then
    raise exception 'not_authorized';
  end if;

  select jsonb_build_object(
    'total_calls', count(*),
    'answered', count(*) filter (where b.answered_at is not null or lower(coalesce(b.status,'')) in ('answered','completed','in_progress','bridged')),
    'failed', count(*) filter (where lower(coalesce(b.status,'')) in ('failed','rejected','busy','no_answer','error','cancelled')),
    'active', count(*) filter (where b.is_active),
    'total_cost', coalesce(sum(b.cost_amount), 0),
    'total_minutes', round(coalesce(sum(b.duration_seconds),0)/60.0, 1),
    'avg_duration_seconds', round(coalesce(avg(nullif(b.duration_seconds,0)),0)::numeric, 0),
    'avg_cost', round(coalesce(avg(nullif(b.cost_amount,0)),0)::numeric, 2)
  ) into v
  from public.crm_call_sessions b
  where (p_from is null or b.created_at >= p_from) and (p_to is null or b.created_at < p_to);

  select coalesce(jsonb_agg(x order by x->>'day'), '[]'::jsonb) into v_daily from (
    select jsonb_build_object(
      'day', to_char(date_trunc('day', b.created_at), 'YYYY-MM-DD'),
      'calls', count(*),
      'answered', count(*) filter (where b.answered_at is not null),
      'cost', round(coalesce(sum(b.cost_amount),0)::numeric, 2),
      'minutes', round(coalesce(sum(b.duration_seconds),0)/60.0, 1)
    ) as x
    from public.crm_call_sessions b
    where (p_from is null or b.created_at >= p_from) and (p_to is null or b.created_at < p_to)
    group by date_trunc('day', b.created_at)
  ) d;

  select coalesce(jsonb_agg(jsonb_build_object('status', s, 'calls', c) order by c desc), '[]'::jsonb) into v_status from (
    select coalesce(nullif(b.status,''), 'unknown') as s, count(*) as c
    from public.crm_call_sessions b
    where (p_from is null or b.created_at >= p_from) and (p_to is null or b.created_at < p_to)
    group by 1
  ) t;

  return v || jsonb_build_object('daily', v_daily, 'by_status', v_status);
end;
$$;

grant execute on function public.voice_call_log_authorized(uuid) to authenticated;
grant execute on function public.get_voice_call_log(text, text, timestamptz, timestamptz, integer, integer) to authenticated;
grant execute on function public.get_voice_call_stats(timestamptz, timestamptz) to authenticated;