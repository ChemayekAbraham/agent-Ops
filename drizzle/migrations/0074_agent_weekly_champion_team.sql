CREATE OR REPLACE FUNCTION public.get_agent_weekly_champion_team(p_week_start date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_week_start date;
  v_champ record;
  v_team_name text;
  v_top jsonb;
  v_parent uuid;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;

  -- default: the week that has just finished (Monday-anchored, Kampala)
  v_week_start := COALESCE(p_week_start, public.agent_league_week_start(now()) - 7);

  SELECT * INTO v_champ
  FROM public.agent_league_week_ranks(v_week_start)
  WHERE team_rank = 1;

  IF v_champ.parent_agent_id IS NULL THEN
    RETURN jsonb_build_object(
      'week_start', v_week_start,
      'week_end', v_week_start + 6,
      'has_champion', false
    );
  END IF;

  SELECT COALESCE(NULLIF(split_part(COALESCE(p.full_name, ''), ' ', 1), ''), 'Welile')
    INTO v_team_name
  FROM public.profiles p WHERE p.id = v_champ.parent_agent_id;

  v_parent := public.agent_league_team_parent(v_user);

  WITH members AS (
    SELECT v_champ.parent_agent_id AS agent_id
    UNION
    SELECT h.member_agent_id
    FROM public.agent_team_membership_history h
    WHERE h.parent_agent_id = v_champ.parent_agent_id
      AND h.valid_from::date <= v_week_start + 6
      AND (h.valid_to IS NULL OR h.valid_to::date >= v_week_start)
  ),
  collections AS (
    SELECT c.agent_id, SUM(c.amount)::numeric AS collected, COUNT(*)::int AS payments
    FROM public.agent_collections c
    JOIN members m ON m.agent_id = c.agent_id
    WHERE c.amount > 0
      AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED]%'
      AND (timezone('Africa/Kampala', c.created_at))::date BETWEEN v_week_start AND v_week_start + 6
    GROUP BY c.agent_id
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'position'), '[]'::jsonb) INTO v_top
  FROM (
    SELECT jsonb_build_object(
             'position', ROW_NUMBER() OVER (ORDER BY co.collected DESC, co.payments DESC, co.agent_id),
             'agent_id', co.agent_id,
             'name', COALESCE(NULLIF(pr.full_name, ''), 'Welile agent'),
             'collected_amount', co.collected,
             'payments', co.payments,
             'is_me', co.agent_id = v_user
           ) AS x
    FROM collections co
    LEFT JOIN public.profiles pr ON pr.id = co.agent_id
    ORDER BY co.collected DESC, co.payments DESC, co.agent_id
    LIMIT 3
  ) s;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'week_end', v_week_start + 6,
    'has_champion', true,
    'team', jsonb_build_object(
      'parent_agent_id', v_champ.parent_agent_id,
      'team_name', 'Team ' || COALESCE(v_team_name, 'Welile'),
      'is_my_team', v_champ.parent_agent_id = v_parent,
      'expected_amount', v_champ.expected_amount,
      'collected_amount', v_champ.collected_amount,
      'performance_percentage', v_champ.performance,
      'active_collectors', v_champ.active_collectors,
      'total_members', v_champ.total_members,
      'consistency_days', v_champ.consistency
    ),
    'top_collectors', COALESCE(v_top, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_weekly_champion_team(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_weekly_champion_team(date) TO authenticated;