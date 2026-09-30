CREATE OR REPLACE FUNCTION public.get_agent_weekly_collection_streak(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_week_start date := date_trunc('week', (now() AT TIME ZONE 'Africa/Kampala'))::date;
  v_days jsonb;
  v_active int;
  v_missed int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_agent <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM user_roles ur WHERE ur.user_id = auth.uid()
      AND ur.role IN ('agent_ops','manager','super_admin','coo','ceo','cfo')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH days AS (
    SELECT d::date AS day FROM generate_series(v_week_start, v_week_start + 6, interval '1 day') d
  ), due AS (
    SELECT dd.day, rr.id AS rent_request_id, rr.tenant_id
    FROM days dd
    JOIN rent_requests rr
      ON COALESCE(rr.assigned_agent_id, rr.agent_id) = v_agent
     AND rr.status IN ('funded','repaying','completed')
     AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
     AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) <= dd.day
     AND lower(COALESCE(rr.repayment_frequency,'daily')) <> 'weekly'
     AND (rr.status <> 'completed' OR EXISTS (
          SELECT 1 FROM agent_collections c WHERE c.rent_request_id = rr.id AND c.reversed_at IS NULL
            AND c.amount > 0 AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date >= dd.day))
    WHERE dd.day <= v_today
  ), paid AS (
    SELECT d.day, d.rent_request_id,
      EXISTS (SELECT 1 FROM agent_collections c
        WHERE c.reversed_at IS NULL AND c.amount > 0
          AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day
          AND (c.rent_request_id = d.rent_request_id
               OR (c.rent_request_id IS NULL AND c.tenant_id = d.tenant_id))) AS ok
    FROM due d
  ), per_day AS (
    SELECT dd.day,
      COUNT(p.rent_request_id) AS tenants_due,
      COUNT(p.rent_request_id) FILTER (WHERE p.ok) AS tenants_paid
    FROM days dd LEFT JOIN paid p ON p.day = dd.day
    GROUP BY dd.day
  )
  SELECT jsonb_agg(jsonb_build_object(
      'day', day, 'tenants_due', tenants_due, 'tenants_paid', tenants_paid,
      'state', CASE WHEN day > v_today THEN 'upcoming'
                    WHEN tenants_due > 0 AND tenants_paid = tenants_due THEN 'active'
                    WHEN day = v_today THEN 'in_progress'
                    ELSE 'missed' END) ORDER BY day),
    COUNT(*) FILTER (WHERE day <= v_today AND tenants_due > 0 AND tenants_paid = tenants_due),
    COUNT(*) FILTER (WHERE day < v_today AND NOT (tenants_due > 0 AND tenants_paid = tenants_due))
  INTO v_days, v_active, v_missed
  FROM per_day;

  RETURN jsonb_build_object(
    'week_start', v_week_start, 'week_end', v_week_start + 6, 'today', v_today,
    'active_days', v_active, 'missed_days', v_missed,
    'best_possible_active', 7 - v_missed,
    'days', v_days,
    'payouts_enabled', false);
END $$;

REVOKE ALL ON FUNCTION public.get_agent_weekly_collection_streak(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_weekly_collection_streak(uuid) TO authenticated;