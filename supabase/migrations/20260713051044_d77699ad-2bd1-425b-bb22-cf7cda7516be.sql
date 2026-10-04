CREATE OR REPLACE FUNCTION public.get_agent_daily_activity_report(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Nairobi')::date - 1))
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
  v_houses int;
  v_rent_requests int;
  v_repay_count int;
  v_repay_amount numeric;
  v_collections_count int;
  v_collections_amount numeric;
  v_visits int;
  v_new_subagents int;
  v_subagent_invites int;
  v_supporter_invites int;
  v_active_agents int;
  v_active_subagents int;
  v_total_agents int;
  v_total_subagents int;
  v_top jsonb;
BEGIN
  v_start := (p_date::timestamp AT TIME ZONE 'UTC') - interval '3 hours';
  v_end := v_start + interval '1 day';

  SELECT count(*) INTO v_houses FROM public.house_listings
    WHERE created_at >= v_start AND created_at < v_end;

  SELECT count(*) INTO v_rent_requests FROM public.rent_requests
    WHERE created_at >= v_start AND created_at < v_end;

  SELECT count(*), coalesce(sum(amount), 0) INTO v_repay_count, v_repay_amount
    FROM public.repayments
    WHERE created_at >= v_start AND created_at < v_end;

  SELECT count(*), coalesce(sum(amount), 0) INTO v_collections_count, v_collections_amount
    FROM public.agent_collections
    WHERE created_at >= v_start AND created_at < v_end;

  SELECT count(*) INTO v_visits FROM public.agent_visits
    WHERE created_at >= v_start AND created_at < v_end;

  SELECT count(*) INTO v_new_subagents FROM public.agent_subagents
    WHERE created_at >= v_start AND created_at < v_end;

  SELECT count(*) INTO v_subagent_invites FROM public.agent_subagents
    WHERE invite_sent_at >= v_start AND invite_sent_at < v_end;

  SELECT count(*) INTO v_supporter_invites FROM public.supporter_invites
    WHERE created_at >= v_start AND created_at < v_end;

  SELECT count(*) INTO v_total_agents FROM public.agent_ops_qualifying_agent_ids();
  SELECT count(*) INTO v_total_subagents FROM public.agent_subagents;

  WITH active AS (
    SELECT agent_id FROM public.agent_collections WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION
    SELECT agent_id FROM public.agent_visits WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION
    SELECT agent_id FROM public.house_listings WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION
    SELECT agent_id FROM public.rent_requests WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
  )
  SELECT count(DISTINCT agent_id) INTO v_active_agents FROM active;

  SELECT count(DISTINCT s.sub_agent_id) INTO v_active_subagents
  FROM public.agent_subagents s
  WHERE s.sub_agent_id IN (
    SELECT agent_id FROM public.agent_collections WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION
    SELECT agent_id FROM public.agent_visits WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION
    SELECT agent_id FROM public.house_listings WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION
    SELECT agent_id FROM public.rent_requests WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
  );

  WITH acts AS (
    SELECT agent_id, 'collection' AS kind, amount FROM public.agent_collections WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION ALL
    SELECT agent_id, 'visit', 0 FROM public.agent_visits WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION ALL
    SELECT agent_id, 'house', 0 FROM public.house_listings WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
    UNION ALL
    SELECT agent_id, 'rent_request', 0 FROM public.rent_requests WHERE created_at >= v_start AND created_at < v_end AND agent_id IS NOT NULL
  ),
  agg AS (
    SELECT
      a.agent_id,
      count(*) FILTER (WHERE kind = 'collection') AS collections,
      coalesce(sum(amount) FILTER (WHERE kind = 'collection'), 0) AS collected,
      count(*) FILTER (WHERE kind = 'visit') AS visits,
      count(*) FILTER (WHERE kind = 'house') AS houses,
      count(*) FILTER (WHERE kind = 'rent_request') AS rent_requests,
      count(*) AS total_actions
    FROM acts a
    GROUP BY a.agent_id
  )
  SELECT jsonb_agg(row_to_json(t))
  INTO v_top
  FROM (
    SELECT
      agg.agent_id,
      coalesce(p.full_name, 'Unknown') AS name,
      p.phone,
      agg.collections, agg.collected, agg.visits, agg.houses, agg.rent_requests, agg.total_actions
    FROM agg
    LEFT JOIN public.profiles p ON p.id = agg.agent_id
    ORDER BY agg.total_actions DESC, agg.collected DESC
    LIMIT 15
  ) t;

  v_result := jsonb_build_object(
    'report_date', p_date,
    'totals', jsonb_build_object(
      'active_agents', v_active_agents,
      'active_subagents', v_active_subagents,
      'total_agents', v_total_agents,
      'total_subagents', v_total_subagents,
      'new_subagents', v_new_subagents,
      'houses_listed', v_houses,
      'rent_requests_posted', v_rent_requests,
      'repayments_count', v_repay_count,
      'repayments_amount', v_repay_amount,
      'collections_count', v_collections_count,
      'collections_amount', v_collections_amount,
      'visits', v_visits,
      'subagent_invites', v_subagent_invites,
      'supporter_invites', v_supporter_invites,
      'invites_total', v_subagent_invites + v_supporter_invites
    ),
    'top_agents', coalesce(v_top, '[]'::jsonb)
  );

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_daily_activity_report(date) TO authenticated, service_role;