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
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_uid
      AND role::text IN ('manager','operations','COO','CEO','CFO','super_admin')
  ) OR EXISTS (
    SELECT 1 FROM public.staff_permissions
    WHERE user_id = v_uid
      AND (permissions ? 'agent_ops' OR permissions ? 'agent-ops' OR permissions ? 'all')
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_week_start := date_trunc('week', now() AT TIME ZONE 'UTC');
  v_week_end := v_week_start + interval '7 days';

  SELECT COUNT(*) INTO v_invites
  FROM public.agent_subagents
  WHERE created_at >= v_week_start AND created_at < v_week_end;

  SELECT COUNT(*) INTO v_verified
  FROM public.house_listings
  WHERE verified_at IS NOT NULL
    AND verified_at >= v_week_start AND verified_at < v_week_end;

  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO v_bonuses_count, v_bonuses_amount
  FROM public.agent_listing_campaign_bonuses
  WHERE awarded_at >= v_week_start AND awarded_at < v_week_end;

  SELECT COALESCE(jsonb_agg(row_to_json(b) ORDER BY b.awarded_at DESC), '[]'::jsonb)
  INTO v_bonuses
  FROM (
    SELECT
      b.id,
      b.agent_id,
      p.full_name AS agent_name,
      p.phone_number AS agent_phone,
      b.invited_count,
      b.activated_count,
      b.verified_houses_count,
      b.amount,
      b.awarded_at
    FROM public.agent_listing_campaign_bonuses b
    LEFT JOIN public.profiles p ON p.id = b.agent_id
    WHERE b.awarded_at >= v_week_start AND b.awarded_at < v_week_end
  ) b;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO v_top_agents
  FROM (
    WITH invited AS (
      SELECT parent_agent_id AS agent_id, COUNT(*) AS invited
      FROM public.agent_subagents
      WHERE created_at >= v_week_start AND created_at < v_week_end
      GROUP BY parent_agent_id
    ),
    verified AS (
      SELECT listing_agent_id AS agent_id, COUNT(*) AS verified_houses
      FROM public.house_listings
      WHERE verified_at IS NOT NULL
        AND verified_at >= v_week_start AND verified_at < v_week_end
        AND listing_agent_id IS NOT NULL
      GROUP BY listing_agent_id
    ),
    combined AS (
      SELECT COALESCE(i.agent_id, v.agent_id) AS agent_id,
             COALESCE(i.invited, 0) AS invited,
             COALESCE(v.verified_houses, 0) AS verified_houses
      FROM invited i
      FULL OUTER JOIN verified v ON v.agent_id = i.agent_id
    )
    SELECT c.agent_id,
           p.full_name AS agent_name,
           p.phone_number AS agent_phone,
           c.verified_houses,
           c.invited
    FROM combined c
    LEFT JOIN public.profiles p ON p.id = c.agent_id
    ORDER BY c.verified_houses DESC, c.invited DESC
    LIMIT 25
  ) t;

  SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.day), '[]'::jsonb)
  INTO v_daily_series
  FROM (
    WITH days AS (
      SELECT generate_series(
        v_week_start,
        v_week_end - interval '1 day',
        interval '1 day'
      )::date AS day
    ),
    invites AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
             COUNT(*) AS invited
      FROM public.agent_subagents
      WHERE created_at >= v_week_start AND created_at < v_week_end
      GROUP BY 1
    ),
    verified AS (
      SELECT date_trunc('day', verified_at AT TIME ZONE 'UTC')::date AS day,
             COUNT(*) AS verified_houses
      FROM public.house_listings
      WHERE verified_at IS NOT NULL
        AND verified_at >= v_week_start AND verified_at < v_week_end
      GROUP BY 1
    )
    SELECT d.day,
           COALESCE(i.invited, 0)::int AS invited,
           COALESCE(v.verified_houses, 0)::int AS verified_houses
    FROM days d
    LEFT JOIN invites i ON i.day = d.day
    LEFT JOIN verified v ON v.day = d.day
  ) d;

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

GRANT EXECUTE ON FUNCTION public.get_agent_listing_campaign_ops_overview() TO authenticated;