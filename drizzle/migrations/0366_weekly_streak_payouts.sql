CREATE OR REPLACE FUNCTION public._agent_week_active_days(p_agent uuid, p_week_start date)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH days AS (
    SELECT d::date AS day FROM generate_series(p_week_start, p_week_start + 6, interval '1 day') d
  ), due AS (
    SELECT dd.day, rr.id AS rent_request_id, rr.tenant_id
    FROM days dd
    JOIN rent_requests rr
      ON COALESCE(rr.assigned_agent_id, rr.agent_id) = p_agent
     AND rr.status IN ('funded','repaying','completed')
     AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
     AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) <= dd.day
     AND lower(COALESCE(rr.repayment_frequency,'daily')) <> 'weekly'
     AND (rr.status <> 'completed' OR EXISTS (
          SELECT 1 FROM agent_collections c WHERE c.rent_request_id = rr.id AND c.reversed_at IS NULL
            AND c.amount > 0 AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date >= dd.day))
  ), paid AS (
    SELECT d.day, d.rent_request_id,
      EXISTS (SELECT 1 FROM agent_collections c
        WHERE c.reversed_at IS NULL AND c.amount > 0
          AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day
          AND (c.rent_request_id = d.rent_request_id
               OR (c.rent_request_id IS NULL AND c.tenant_id = d.tenant_id))) AS ok
    FROM due d
  ), per_day AS (
    SELECT day, COUNT(*) AS due_n, COUNT(*) FILTER (WHERE ok) AS paid_n FROM paid GROUP BY day
  )
  SELECT COUNT(*)::int FROM per_day WHERE due_n > 0 AND paid_n = due_n;
$$;
REVOKE ALL ON FUNCTION public._agent_week_active_days(uuid, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.process_weekly_streak_payouts(p_week_start date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_week date := COALESCE(p_week_start,
    date_trunc('week', (now() AT TIME ZONE 'Africa/Kampala'))::date - 7);
  v_agent uuid; v_active int; v_amount numeric; v_row uuid; v_src text; v_desc text;
  v_paid int := 0; v_total numeric := 0;
BEGIN
  IF v_week + 6 >= (now() AT TIME ZONE 'Africa/Kampala')::date THEN
    RAISE EXCEPTION 'week % has not finished', v_week;
  END IF;

  FOR v_agent IN
    SELECT DISTINCT COALESCE(assigned_agent_id, agent_id) FROM rent_requests
    WHERE COALESCE(assigned_agent_id, agent_id) IS NOT NULL
      AND status IN ('funded','repaying','completed')
  LOOP
    v_active := public._agent_week_active_days(v_agent, v_week);
    v_amount := CASE WHEN v_active >= 7 THEN 50000 WHEN v_active = 6 THEN 30000
                     WHEN v_active = 5 THEN 20000 WHEN v_active = 4 THEN 10000 ELSE 0 END;
    CONTINUE WHEN v_amount = 0;

    v_src := 'weekly_streak:' || v_agent || ':' || v_week;
    CONTINUE WHEN EXISTS (SELECT 1 FROM commission_accrual_ledger
      WHERE source_id = v_src AND event_type = 'weekly_collection_streak');

    v_desc := format('Weekly Collection Streak reward: %s/7 active days (week of %s)', v_active, v_week);

    BEGIN
      INSERT INTO commission_accrual_ledger (agent_id, event_type, commission_role, source_type,
        source_id, amount, description, status, earned_at, created_at)
      VALUES (v_agent, 'weekly_collection_streak', 'event_bonus', 'weekly_collection_streak',
        v_src, v_amount, v_desc, 'pending', now(), now())
      RETURNING id INTO v_row;

      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_agent, 'amount', v_amount, 'direction', 'cash_in',
            'category', 'agent_commission', 'ledger_scope', 'wallet', 'recipient_type', 'user',
            'source_table', 'commission_accrual_ledger', 'source_id', v_row::text, 'description', v_desc),
          jsonb_build_object('user_id', v_agent, 'amount', v_amount, 'direction', 'cash_out',
            'category', 'marketing_expense', 'ledger_scope', 'platform',
            'source_table', 'commission_accrual_ledger', 'source_id', v_row::text,
            'description', 'Marketing expense: ' || v_desc)
        ),
        v_src);

      UPDATE commission_accrual_ledger SET status = 'credited', paid_at = now() WHERE id = v_row;

      INSERT INTO system_events (event_type, user_id, metadata)
      VALUES ('agent_collection', v_agent, jsonb_build_object('kind','weekly_collection_streak_paid',
        'week_start', v_week, 'active_days', v_active, 'amount', v_amount));

      v_paid := v_paid + 1; v_total := v_total + v_amount;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'streak payout failed for % week %: %', v_agent, v_week, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('week_start', v_week, 'agents_paid', v_paid, 'total', v_total);
END $$;
REVOKE ALL ON FUNCTION public.process_weekly_streak_payouts(date) FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.get_agent_weekly_collection_streak(uuid)'::regprocedure);
  EXECUTE replace(d, '''payouts_enabled'', false', '''payouts_enabled'', true');
END $do$;

SELECT cron.schedule('weekly-collection-streak-payouts', '15 21 * * 0',
  $$ SELECT public.process_weekly_streak_payouts(); $$);