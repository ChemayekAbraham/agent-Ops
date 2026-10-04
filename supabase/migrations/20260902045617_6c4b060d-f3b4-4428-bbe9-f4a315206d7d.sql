-- Shared working-day definition: Monday..Saturday (26-day month assumption)
CREATE OR REPLACE FUNCTION public.proxy_pv_is_working_day(p_day date)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT EXTRACT(ISODOW FROM p_day) < 7;
$$;

REVOKE ALL ON FUNCTION public.proxy_pv_is_working_day(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proxy_pv_is_working_day(date) TO authenticated, service_role;

-- Working days elapsed: Mon..Sat, capped at the configured working-day count
CREATE OR REPLACE FUNCTION public.proxy_pv_working_days_elapsed(p_month date DEFAULT NULL)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH b AS (
    SELECT date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date AS ms,
           (now() AT TIME ZONE 'Africa/Kampala')::date AS today
  ), cfg AS (
    SELECT GREATEST((public.proxy_pv_target_for((SELECT ms FROM b))->>'working_days')::int, 1) AS wd
  ), counted AS (
    SELECT COUNT(*)::int AS n
      FROM b, generate_series(b.ms, LEAST((b.ms + interval '1 month - 1 day')::date, b.today), interval '1 day') g
     WHERE public.proxy_pv_is_working_day(g::date)
  )
  SELECT LEAST(counted.n, cfg.wd) FROM counted, cfg;
$$;

REVOKE ALL ON FUNCTION public.proxy_pv_working_days_elapsed(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proxy_pv_working_days_elapsed(date) TO authenticated, service_role;

-- Individual PV report: working-day aligned history, expected MTD and today's target
CREATE OR REPLACE FUNCTION public.get_proxy_agent_pv(p_agent_id uuid DEFAULT NULL, p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_agent uuid := public.proxy_cc_resolve_agent(p_agent_id);
  v_month date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cfg jsonb := public.proxy_pv_target_for(v_month);
  v_target numeric := (v_cfg->>'monthly_pv_target')::numeric;
  v_wd int := GREATEST((v_cfg->>'working_days')::int, 1);
  v_daily numeric := ROUND(v_target / GREATEST((v_cfg->>'working_days')::int, 1));
  v_elapsed int := public.proxy_pv_working_days_elapsed(v_month);
  v_expected numeric;
  v_rate numeric := COALESCE(public.partner_note_rate('agent', now()), 1500);
  v_rows jsonb;
  v_mtd record;
  v_day record;
  v_name text;
  v_end date;
  v_today_working boolean := public.proxy_pv_is_working_day(v_today);
  v_today_target numeric;
BEGIN
  v_expected := ROUND(v_target * (LEAST(v_elapsed, v_wd)::numeric / v_wd));
  v_end := LEAST((v_month + interval '1 month - 1 day')::date, v_today);
  v_today_target := CASE WHEN v_today_working THEN v_daily ELSE 0 END;

  -- Month-to-date totals keep every posting, working day or not, so no PV is lost.
  SELECT COALESCE(SUM(d.commitments),0)::int AS commitments,
         COALESCE(SUM(d.new_investment),0) AS new_investment,
         COALESCE(SUM(d.topups),0) AS topups,
         COALESCE(SUM(d.commitment_pv),0) AS commitment_pv,
         COALESCE(SUM(d.investment_pv),0) AS investment_pv,
         COALESCE(SUM(d.topup_pv),0) AS topup_pv,
         COALESCE(SUM(d.total_pv),0) AS total_pv
    INTO v_mtd
    FROM public.proxy_pv_daily(v_agent, v_month) d
   WHERE d.day <= v_end;

  SELECT d.commitments, d.new_investment, d.topups, d.commitment_pv, d.investment_pv, d.topup_pv, d.total_pv
    INTO v_day
    FROM public.proxy_pv_daily(v_agent, v_month) d
   WHERE d.day = v_today;

  -- Daily history is working days only (Mon..Sat).
  SELECT jsonb_agg(jsonb_build_object(
           'day', d.day,
           'commitments', d.commitments,
           'new_investment', d.new_investment,
           'topups', d.topups,
           'commitment_pv', d.commitment_pv,
           'investment_pv', d.investment_pv,
           'topup_pv', d.topup_pv,
           'total_pv', d.total_pv,
           'daily_target', v_daily,
           'performance_pct', CASE WHEN v_daily > 0 THEN ROUND((d.total_pv / v_daily) * 100, 1) ELSE 0 END,
           'is_working_day', true
         ) ORDER BY d.day)
    INTO v_rows
    FROM public.proxy_pv_daily(v_agent, v_month) d
   WHERE d.day <= v_end
     AND public.proxy_pv_is_working_day(d.day);

  SELECT COALESCE(NULLIF(btrim(full_name),''), 'Proxy agent') INTO v_name FROM public.profiles WHERE id = v_agent;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'agent_name', v_name,
    'period_month', v_month,
    'generated_at', now(),
    'rates', jsonb_build_object('commitment_pv', v_rate, 'investment_pct', 2, 'topup_pct', 1),
    'targets', jsonb_build_object(
      'monthly_pv_target', v_target,
      'working_days', v_wd,
      'daily_pv_target', v_daily,
      'working_days_elapsed', v_elapsed,
      'working_days_remaining', GREATEST(v_wd - v_elapsed, 0),
      'expected_mtd_pv', v_expected
    ),
    'today', jsonb_build_object(
      'date', v_today,
      'is_working_day', v_today_working,
      'commitments', COALESCE(v_day.commitments, 0),
      'new_investment', COALESCE(v_day.new_investment, 0),
      'topups', COALESCE(v_day.topups, 0),
      'commitment_pv', COALESCE(v_day.commitment_pv, 0),
      'investment_pv', COALESCE(v_day.investment_pv, 0),
      'topup_pv', COALESCE(v_day.topup_pv, 0),
      'total_pv', COALESCE(v_day.total_pv, 0),
      'target_pv', v_today_target,
      'performance_pct', CASE WHEN v_today_target > 0 THEN ROUND((COALESCE(v_day.total_pv,0) / v_today_target) * 100, 1) ELSE 0 END
    ),
    'mtd', jsonb_build_object(
      'commitments', v_mtd.commitments,
      'new_investment', v_mtd.new_investment,
      'topups', v_mtd.topups,
      'commitment_pv', v_mtd.commitment_pv,
      'investment_pv', v_mtd.investment_pv,
      'topup_pv', v_mtd.topup_pv,
      'total_pv', v_mtd.total_pv,
      'expected_pv', v_expected,
      'performance_pct', CASE WHEN v_expected > 0 THEN ROUND((v_mtd.total_pv / v_expected) * 100, 1) ELSE 0 END,
      'monthly_performance_pct', CASE WHEN v_target > 0 THEN ROUND((v_mtd.total_pv / v_target) * 100, 1) ELSE 0 END,
      'remaining_to_target', GREATEST(v_target - v_mtd.total_pv, 0),
      'above_target', GREATEST(v_mtd.total_pv - v_target, 0)
    ),
    'daily', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_proxy_agent_pv(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_proxy_agent_pv(uuid, date) TO authenticated;