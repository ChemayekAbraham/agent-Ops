CREATE OR REPLACE FUNCTION public.get_agent_listing_campaign_ops_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  WITH invited AS (
    SELECT parent_agent_id AS agent_id, COUNT(*) AS invited_count
    FROM public.agent_subagents
    WHERE created_at >= v_week_start AND created_at < v_week_end
    GROUP BY parent_agent_id
  ),
  verified AS (
    SELECT agent_id, COUNT(*) AS verified_count
    FROM public.house_listings
    WHERE verified_at IS NOT NULL
      AND verified_at >= v_week_start AND verified_at < v_week_end
    GROUP BY agent_id
  ),
  merged AS (
    SELECT COALESCE(i.agent_id, v.agent_id) AS agent_id,
           COALESCE(i.invited_count,0) AS invited_count,
           COALESCE(v.verified_count,0) AS verified_count
    FROM invited i FULL OUTER JOIN verified v ON i.agent_id = v.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'agent_id', m.agent_id,
    'agent_name', COALESCE(p.full_name, p.phone, 'Agent'),
    'invited_count', m.invited_count,
    'verified_count', m.verified_count
  ) ORDER BY m.verified_count DESC, m.invited_count DESC), '[]'::jsonb)
  INTO v_top_agents
  FROM (SELECT * FROM merged ORDER BY verified_count DESC, invited_count DESC LIMIT 25) m
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
$$;