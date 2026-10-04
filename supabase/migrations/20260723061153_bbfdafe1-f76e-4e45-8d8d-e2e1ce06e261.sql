CREATE OR REPLACE FUNCTION public.get_agent_listing_campaign_ops_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_authorized boolean := false;
  v_week_start timestamptz;
  v_week_end timestamptz;
  v_invites int;
  v_verified int;
  v_bonuses_count int;
  v_bonuses_amount numeric;
  v_bonuses jsonb;
  v_top_agents jsonb;
  v_daily_series jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_uid
      AND role::text IN ('manager','operations','COO','CEO','CFO','super_admin')
  ) OR EXISTS (
    SELECT 1 FROM public.staff_permissions
    WHERE user_id = v_uid
      AND permitted_dashboard IN ('agent_ops','agent-ops','all')
  ) INTO v_authorized;

  IF NOT v_authorized THEN RAISE EXCEPTION 'Not authorized'; END IF;

  v_week_start := date_trunc('week', now() AT TIME ZONE 'UTC');
  v_week_end := v_week_start + interval '7 days';

  SELECT COUNT(*) INTO v_invites FROM public.agent_subagents
  WHERE created_at >= v_week_start AND created_at < v_week_end;

  SELECT COUNT(*) INTO v_verified FROM public.house_listings
  WHERE verified_at IS NOT NULL AND verified_at >= v_week_start AND verified_at < v_week_end;

  SELECT COUNT(*), COALESCE(SUM(amount),0)
    INTO v_bonuses_count, v_bonuses_amount
  FROM public.agent_listing_campaign_bonuses
  WHERE awarded_at >= v_week_start AND awarded_at < v_week_end;

  SELECT COALESCE(jsonb_agg(to_jsonb(b.*) ORDER BY b.awarded_at DESC), '[]'::jsonb)
    INTO v_bonuses
  FROM public.agent_listing_campaign_bonuses b
  WHERE b.awarded_at >= v_week_start AND b.awarded_at < v_week_end;

  WITH sub_agents_all AS (
    SELECT parent_agent_id AS agent_id, sub_agent_id
    FROM public.agent_subagents
  ),
  sub_agents_week AS (
    SELECT parent_agent_id AS agent_id, sub_agent_id
    FROM public.agent_subagents
    WHERE created_at >= v_week_start AND created_at < v_week_end
      AND status <> 'rejected'
  ),
  sub_counts AS (
    SELECT agent_id, COUNT(DISTINCT sub_agent_id) AS sub_agents_count
    FROM sub_agents_all
    GROUP BY agent_id
  ),
  sub_counts_week AS (
    SELECT agent_id, COUNT(DISTINCT sub_agent_id) AS sub_agents_week
    FROM sub_agents_week
    GROUP BY agent_id
  ),
  houses_by_subs AS (
    SELECT s.agent_id, COUNT(hl.id) AS houses_listed_count
    FROM sub_agents_all s
    JOIN public.house_listings hl ON hl.agent_id = s.sub_agent_id
    GROUP BY s.agent_id
  ),
  -- Verified houses THIS WEEK per sub-agent, scoped to that parent's invitees
  verified_by_sub_week AS (
    SELECT s.agent_id AS parent_agent_id,
           s.sub_agent_id,
           COUNT(hl.id) AS v_houses
    FROM sub_agents_week s
    JOIN public.house_listings hl ON hl.agent_id = s.sub_agent_id
    WHERE hl.verified = true
      AND hl.status <> 'rejected'
      AND COALESCE(hl.is_hidden, false) = false
      AND hl.created_at >= v_week_start AND hl.created_at < v_week_end
    GROUP BY s.agent_id, s.sub_agent_id
  ),
  activated_week AS (
    SELECT parent_agent_id AS agent_id,
           COUNT(*) FILTER (WHERE v_houses >= 3) AS activated_subs_week,
           COALESCE(SUM(v_houses), 0) AS verified_houses_week
    FROM verified_by_sub_week
    GROUP BY parent_agent_id
  ),
  -- Fallback: overall verified this week by agent (self-listings included)
  verified_week AS (
    SELECT agent_id, COUNT(*) AS verified_count
    FROM public.house_listings
    WHERE verified_at IS NOT NULL
      AND verified_at >= v_week_start AND verified_at < v_week_end
    GROUP BY agent_id
  ),
  merged AS (
    SELECT
      COALESCE(sc.agent_id, hs.agent_id, vw.agent_id, aw.agent_id, scw.agent_id) AS agent_id,
      COALESCE(sc.sub_agents_count, 0) AS sub_agents_count,
      COALESCE(scw.sub_agents_week, 0) AS sub_agents_week,
      COALESCE(hs.houses_listed_count, 0) AS houses_listed_count,
      COALESCE(vw.verified_count, 0) AS verified_count,
      COALESCE(aw.activated_subs_week, 0) AS activated_subs_week,
      COALESCE(aw.verified_houses_week, 0) AS verified_houses_week
    FROM sub_counts sc
    FULL OUTER JOIN sub_counts_week scw ON scw.agent_id = sc.agent_id
    FULL OUTER JOIN houses_by_subs hs ON hs.agent_id = COALESCE(sc.agent_id, scw.agent_id)
    FULL OUTER JOIN verified_week vw ON vw.agent_id = COALESCE(sc.agent_id, scw.agent_id, hs.agent_id)
    FULL OUTER JOIN activated_week aw ON aw.agent_id = COALESCE(sc.agent_id, scw.agent_id, hs.agent_id, vw.agent_id)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'agent_id', m.agent_id,
    'agent_name', COALESCE(p.full_name, p.phone, 'Agent'),
    'agent_phone', p.phone,
    'sub_agents_count', m.sub_agents_count,
    'sub_agents_week', m.sub_agents_week,
    'houses_listed_count', m.houses_listed_count,
    'verified_count', m.verified_count,
    'activated_subs_week', m.activated_subs_week,
    'verified_houses_week', m.verified_houses_week,
    'invited_count', m.sub_agents_count
  ) ORDER BY m.activated_subs_week DESC, m.verified_houses_week DESC, m.sub_agents_week DESC), '[]'::jsonb)
  INTO v_top_agents
  FROM (
    SELECT * FROM merged
    ORDER BY activated_subs_week DESC, verified_houses_week DESC, sub_agents_week DESC, verified_count DESC
    LIMIT 25
  ) m
  LEFT JOIN public.profiles p ON p.id = m.agent_id;

  WITH days AS (
    SELECT generate_series(v_week_start, v_week_end - interval '1 day', interval '1 day')::date AS d
  ),
  inv AS (
    SELECT created_at::date AS d, COUNT(*) AS c
    FROM public.agent_subagents
    WHERE created_at >= v_week_start AND created_at < v_week_end
    GROUP BY 1
  ),
  ver AS (
    SELECT verified_at::date AS d, COUNT(*) AS c
    FROM public.house_listings
    WHERE verified_at IS NOT NULL
      AND verified_at >= v_week_start AND verified_at < v_week_end
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'day', to_char(days.d, 'YYYY-MM-DD'),
    'invited', COALESCE(inv.c,0),
    'verified_houses', COALESCE(ver.c,0)
  ) ORDER BY days.d), '[]'::jsonb)
  INTO v_daily_series
  FROM days LEFT JOIN inv ON inv.d = days.d LEFT JOIN ver ON ver.d = days.d;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'week_end', v_week_end,
    'invites_this_week', v_invites,
    'verified_houses_this_week', v_verified,
    'bonuses_awarded_count', v_bonuses_count,
    'bonuses_awarded_amount', v_bonuses_amount,
    'bonuses', v_bonuses,
    'top_agents', v_top_agents,
    'daily_series', v_daily_series
  );
END;
$function$;