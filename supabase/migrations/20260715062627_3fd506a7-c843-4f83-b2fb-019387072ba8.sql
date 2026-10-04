CREATE OR REPLACE FUNCTION public.get_agent_listing_campaign_ops_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_allowed boolean;
  v_week_start timestamptz := date_trunc('week', now());
  v_week_end timestamptz := v_week_start + interval '7 days';
  v_invites int;
  v_houses int;
  v_bonuses jsonb;
  v_top jsonb;
  v_bonuses_count int;
  v_bonuses_amount numeric;
BEGIN
  v_allowed := has_role(v_uid, 'manager'::app_role)
            OR has_role(v_uid, 'operations'::app_role)
            OR has_role(v_uid, 'coo'::app_role)
            OR has_role(v_uid, 'ceo'::app_role)
            OR has_role(v_uid, 'cfo'::app_role)
            OR has_role(v_uid, 'super_admin'::app_role)
            OR EXISTS (
              SELECT 1 FROM staff_permissions sp
              WHERE sp.user_id = v_uid
                AND sp.permitted_dashboard = ANY (ARRAY['agent_ops','agent_operations','agent_ops_admin','executive_hub'])
            );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT count(*) INTO v_invites
    FROM agent_subagents
   WHERE created_at >= v_week_start AND created_at < v_week_end
     AND status <> 'rejected';

  SELECT count(*) INTO v_houses
    FROM house_listings
   WHERE verified = true
     AND coalesce(is_hidden, false) = false
     AND coalesce(status, '') <> 'rejected'
     AND created_at >= v_week_start
     AND created_at < v_week_end;

  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'awarded_at') DESC), '[]'::jsonb),
         count(*), coalesce(sum((x->>'amount')::numeric), 0)
  INTO v_bonuses, v_bonuses_count, v_bonuses_amount
  FROM (
    SELECT jsonb_build_object(
      'id', b.id,
      'agent_id', b.agent_id,
      'agent_name', p.full_name,
      'agent_phone', p.phone,
      'invited_count', b.invited_count,
      'activated_count', b.activated_count,
      'verified_houses_count', b.verified_houses_count,
      'amount', b.amount,
      'awarded_at', b.awarded_at
    ) AS x
    FROM agent_listing_campaign_bonuses b
    LEFT JOIN profiles p ON p.id = b.agent_id
    WHERE b.week_start >= v_week_start::date
  ) s;

  -- Top agents by verified houses this week (live leaderboard)
  SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY (t.verified_houses) DESC), '[]'::jsonb)
    INTO v_top
  FROM (
    SELECT hl.agent_id,
           p.full_name AS agent_name,
           p.phone AS agent_phone,
           count(*)::int AS verified_houses,
           (SELECT count(*)::int FROM agent_subagents sa
             WHERE sa.parent_agent_id = hl.agent_id
               AND sa.created_at >= v_week_start AND sa.created_at < v_week_end
               AND sa.status <> 'rejected') AS invited
      FROM house_listings hl
      LEFT JOIN profiles p ON p.id = hl.agent_id
     WHERE hl.verified = true
       AND coalesce(hl.is_hidden, false) = false
       AND coalesce(hl.status, '') <> 'rejected'
       AND hl.created_at >= v_week_start
       AND hl.created_at < v_week_end
       AND hl.agent_id IS NOT NULL
     GROUP BY hl.agent_id, p.full_name, p.phone
     ORDER BY verified_houses DESC
     LIMIT 25
  ) t;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'week_end', v_week_end,
    'invites_this_week', v_invites,
    'verified_houses_this_week', v_houses,
    'bonuses_awarded_count', v_bonuses_count,
    'bonuses_awarded_amount', v_bonuses_amount,
    'bonuses', v_bonuses,
    'top_agents', v_top
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_listing_campaign_ops_overview() TO authenticated;