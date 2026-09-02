CREATE TABLE IF NOT EXISTS public.proxy_pv_targets (
  period_month date PRIMARY KEY,
  monthly_pv_target numeric NOT NULL DEFAULT 2000000,
  working_days integer NOT NULL DEFAULT 26,
  note text,
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.proxy_pv_targets TO authenticated;
GRANT ALL ON public.proxy_pv_targets TO service_role;

ALTER TABLE public.proxy_pv_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read proxy PV targets" ON public.proxy_pv_targets;
CREATE POLICY "Authenticated can read proxy PV targets"
ON public.proxy_pv_targets FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.proxy_pv_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_proxy_pv_targets_touch ON public.proxy_pv_targets;
CREATE TRIGGER trg_proxy_pv_targets_touch BEFORE UPDATE ON public.proxy_pv_targets
FOR EACH ROW EXECUTE FUNCTION public.proxy_pv_touch_updated_at();

INSERT INTO public.proxy_pv_targets (period_month, monthly_pv_target, working_days, note)
VALUES (date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date, 2000000, 26, 'Standard monthly Performance Value target')
ON CONFLICT (period_month) DO NOTHING;

CREATE OR REPLACE FUNCTION public.proxy_pv_working_days_elapsed(p_month date)
RETURNS integer LANGUAGE sql STABLE SET search_path = public AS $$
  WITH b AS (
    SELECT date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date AS ms,
           (now() AT TIME ZONE 'Africa/Kampala')::date AS today
  )
  SELECT COUNT(*)::int
    FROM b, generate_series(b.ms, LEAST((b.ms + interval '1 month - 1 day')::date, b.today), interval '1 day') g
   WHERE EXTRACT(ISODOW FROM g) < 6;
$$;

CREATE OR REPLACE FUNCTION public.proxy_pv_target_for(p_month date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
           'monthly_pv_target', COALESCE(t.monthly_pv_target, 2000000),
           'working_days', COALESCE(t.working_days, 26)
         )
    FROM (SELECT 1) x
    LEFT JOIN public.proxy_pv_targets t
           ON t.period_month = date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date;
$$;

CREATE OR REPLACE FUNCTION public.proxy_pv_daily(p_agent_id uuid, p_month date)
RETURNS TABLE (
  day date,
  commitments integer,
  new_investment numeric,
  topups numeric,
  commitment_pv numeric,
  investment_pv numeric,
  topup_pv numeric,
  total_pv numeric
) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH span AS (
    SELECT date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date AS ms,
           (date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))
             + interval '1 month - 1 day')::date AS me
  ), notes AS (
    SELECT (COALESCE(pn.approved_at, pn.updated_at) AT TIME ZONE 'Africa/Kampala')::date AS nd,
           COUNT(*)::int AS c
      FROM public.promissory_notes pn, span s
     WHERE pn.agent_id = p_agent_id
       AND pn.status = 'activated'
       AND (COALESCE(pn.approved_at, pn.updated_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN s.ms AND s.me
     GROUP BY 1
  ), ev AS (
    SELECT (e.created_at AT TIME ZONE 'Africa/Kampala')::date AS ed,
           COALESCE(SUM(e.base_amount) FILTER (WHERE e.kind = 'portfolio_creation'), 0) AS inv_base,
           COALESCE(SUM(e.base_amount) FILTER (WHERE e.kind = 'portfolio_topup'), 0) AS top_base,
           COALESCE(SUM(e.base_amount * e.rate) FILTER (WHERE e.kind = 'portfolio_creation'), 0) AS inv_pv,
           COALESCE(SUM(e.base_amount * e.rate) FILTER (WHERE e.kind = 'portfolio_topup'), 0) AS top_pv
      FROM public.promissory_commission_events e, span s
     WHERE e.agent_id = p_agent_id
       AND e.status = 'paid'
       AND e.kind IN ('portfolio_creation','portfolio_topup')
       AND (e.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN s.ms AND s.me
     GROUP BY 1
  )
  SELECT g.gd::date,
         COALESCE(n.c, 0),
         COALESCE(e.inv_base, 0),
         COALESCE(e.top_base, 0),
         COALESCE(n.c, 0) * COALESCE(public.partner_note_rate('agent', now()), 1500),
         COALESCE(e.inv_pv, 0),
         COALESCE(e.top_pv, 0),
         COALESCE(n.c, 0) * COALESCE(public.partner_note_rate('agent', now()), 1500)
           + COALESCE(e.inv_pv, 0) + COALESCE(e.top_pv, 0)
    FROM span s
    CROSS JOIN generate_series(s.ms, s.me, interval '1 day') AS g(gd)
    LEFT JOIN notes n ON n.nd = g.gd::date
    LEFT JOIN ev e ON e.ed = g.gd::date
   ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION public.get_proxy_agent_pv(p_agent_id uuid DEFAULT NULL, p_month date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
BEGIN
  v_expected := ROUND(v_target * (LEAST(v_elapsed, v_wd)::numeric / v_wd));
  v_end := LEAST((v_month + interval '1 month - 1 day')::date, v_today);

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
           'is_working_day', EXTRACT(ISODOW FROM d.day) < 6
         ) ORDER BY d.day)
    INTO v_rows
    FROM public.proxy_pv_daily(v_agent, v_month) d
   WHERE d.day <= v_end;

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
      'commitments', COALESCE(v_day.commitments, 0),
      'new_investment', COALESCE(v_day.new_investment, 0),
      'topups', COALESCE(v_day.topups, 0),
      'commitment_pv', COALESCE(v_day.commitment_pv, 0),
      'investment_pv', COALESCE(v_day.investment_pv, 0),
      'topup_pv', COALESCE(v_day.topup_pv, 0),
      'total_pv', COALESCE(v_day.total_pv, 0),
      'target_pv', v_daily,
      'performance_pct', CASE WHEN v_daily > 0 THEN ROUND((COALESCE(v_day.total_pv,0) / v_daily) * 100, 1) ELSE 0 END
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
END; $$;

REVOKE ALL ON FUNCTION public.get_proxy_agent_pv(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.get_proxy_agent_pv(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.proxy_pv_agent_rows(p_month date)
RETURNS TABLE (
  agent_user_id uuid,
  name text,
  status text,
  avatar_url text,
  phone text,
  commitments integer,
  commitment_pv numeric,
  new_investment numeric,
  investment_pv numeric,
  topups numeric,
  topup_pv numeric,
  total_pv numeric
) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH span AS (
    SELECT date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date AS ms,
           LEAST((date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))
                   + interval '1 month - 1 day')::date,
                 (now() AT TIME ZONE 'Africa/Kampala')::date) AS me
  ), agents AS (
    SELECT i.agent_user_id AS id,
           COALESCE(NULLIF(btrim(p.full_name),''), NULLIF(btrim(i.full_name),''), 'Unknown agent') AS nm,
           i.status AS st,
           p.avatar_url AS av,
           COALESCE(NULLIF(p.phone,''), i.phone) AS ph
      FROM public.proxy_agent_identity i
      LEFT JOIN public.profiles p ON p.id = i.agent_user_id
  ), notes AS (
    SELECT pn.agent_id AS id, COUNT(*)::int AS c
      FROM public.promissory_notes pn, span s
     WHERE pn.status = 'activated'
       AND (COALESCE(pn.approved_at, pn.updated_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN s.ms AND s.me
     GROUP BY 1
  ), ev AS (
    SELECT e.agent_id AS id,
           COALESCE(SUM(e.base_amount) FILTER (WHERE e.kind = 'portfolio_creation'),0) AS inv_base,
           COALESCE(SUM(e.base_amount) FILTER (WHERE e.kind = 'portfolio_topup'),0) AS top_base,
           COALESCE(SUM(e.base_amount * e.rate) FILTER (WHERE e.kind = 'portfolio_creation'),0) AS inv_pv,
           COALESCE(SUM(e.base_amount * e.rate) FILTER (WHERE e.kind = 'portfolio_topup'),0) AS top_pv
      FROM public.promissory_commission_events e, span s
     WHERE e.status = 'paid'
       AND e.kind IN ('portfolio_creation','portfolio_topup')
       AND (e.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN s.ms AND s.me
     GROUP BY 1
  )
  SELECT a.id, a.nm, a.st, a.av, a.ph,
         COALESCE(n.c,0),
         COALESCE(n.c,0) * COALESCE(public.partner_note_rate('agent', now()), 1500),
         COALESCE(e.inv_base,0),
         COALESCE(e.inv_pv,0),
         COALESCE(e.top_base,0),
         COALESCE(e.top_pv,0),
         COALESCE(n.c,0) * COALESCE(public.partner_note_rate('agent', now()), 1500)
           + COALESCE(e.inv_pv,0) + COALESCE(e.top_pv,0)
    FROM agents a
    LEFT JOIN notes n ON n.id = a.id
    LEFT JOIN ev e ON e.id = a.id;
$$;

CREATE OR REPLACE FUNCTION public.partner_ops_proxy_agent_pv(
  p_month date DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_sort text DEFAULT 'total_pv',
  p_dir text DEFAULT 'desc',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date;
  v_cfg jsonb := public.proxy_pv_target_for(v_month);
  v_target numeric := (v_cfg->>'monthly_pv_target')::numeric;
  v_wd int := GREATEST((v_cfg->>'working_days')::int, 1);
  v_elapsed int := public.proxy_pv_working_days_elapsed(v_month);
  v_expected numeric;
  v_lim int := LEAST(GREATEST(COALESCE(p_limit,50),1),200);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := COALESCE(NULLIF(btrim(COALESCE(p_sort,'')),''), 'total_pv');
  v_asc boolean := lower(COALESCE(p_dir,'desc')) = 'asc';
  v_total int;
  v_rows jsonb;
  v_kpis jsonb;
BEGIN
  IF NOT public.is_proxy_directory_viewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_expected := ROUND(v_target * (LEAST(v_elapsed, v_wd)::numeric / v_wd));

  SELECT jsonb_build_object(
           'agents_total', COUNT(*),
           'team_total_pv', COALESCE(SUM(r.total_pv),0),
           'team_new_investment', COALESCE(SUM(r.new_investment),0),
           'team_topups', COALESCE(SUM(r.topups),0),
           'team_commitments', COALESCE(SUM(r.commitments),0)::int,
           'team_commitment_pv', COALESCE(SUM(r.commitment_pv),0),
           'team_investment_pv', COALESCE(SUM(r.investment_pv),0),
           'team_topup_pv', COALESCE(SUM(r.topup_pv),0),
           'expected_mtd_pv', v_expected,
           'monthly_pv_target', v_target,
           'working_days', v_wd,
           'working_days_elapsed', v_elapsed,
           'working_days_remaining', GREATEST(v_wd - v_elapsed, 0),
           'daily_pv_target', ROUND(v_target / v_wd),
           'at_or_above_target', COUNT(*) FILTER (WHERE v_expected > 0 AND r.total_pv >= v_expected),
           'below_target', COUNT(*) FILTER (WHERE v_expected = 0 OR r.total_pv < v_expected),
           'period_month', v_month
         ) INTO v_kpis
    FROM public.proxy_pv_agent_rows(v_month) r;

  SELECT COUNT(*)::int INTO v_total
    FROM public.proxy_pv_agent_rows(v_month) r
   WHERE v_q IS NULL OR r.name ILIKE '%'||v_q||'%' OR COALESCE(r.phone,'') ILIKE '%'||v_q||'%';

  SELECT jsonb_agg(s.obj) INTO v_rows FROM (
    SELECT jsonb_build_object(
             'agent_user_id', r.agent_user_id,
             'name', r.name,
             'status', r.status,
             'avatar_url', r.avatar_url,
             'phone', r.phone,
             'commitments', r.commitments,
             'commitment_pv', r.commitment_pv,
             'new_investment', r.new_investment,
             'investment_pv', r.investment_pv,
             'topups', r.topups,
             'topup_pv', r.topup_pv,
             'total_pv', r.total_pv,
             'expected_pv', v_expected,
             'performance_pct', CASE WHEN v_expected > 0 THEN ROUND((r.total_pv / v_expected) * 100, 1) ELSE 0 END,
             'monthly_performance_pct', CASE WHEN v_target > 0 THEN ROUND((r.total_pv / v_target) * 100, 1) ELSE 0 END
           ) AS obj
      FROM public.proxy_pv_agent_rows(v_month) r
     WHERE v_q IS NULL OR r.name ILIKE '%'||v_q||'%' OR COALESCE(r.phone,'') ILIKE '%'||v_q||'%'
     ORDER BY
       CASE WHEN v_asc THEN
         CASE v_sort
           WHEN 'commitments' THEN r.commitments::numeric
           WHEN 'new_investment' THEN r.new_investment
           WHEN 'topups' THEN r.topups
           ELSE r.total_pv
         END
       END ASC NULLS LAST,
       CASE WHEN NOT v_asc THEN
         CASE v_sort
           WHEN 'commitments' THEN r.commitments::numeric
           WHEN 'new_investment' THEN r.new_investment
           WHEN 'topups' THEN r.topups
           ELSE r.total_pv
         END
       END DESC NULLS LAST,
       r.name ASC
     LIMIT v_lim OFFSET v_off
  ) s;

  RETURN jsonb_build_object(
    'period_month', v_month,
    'total', v_total,
    'limit', v_lim,
    'offset', v_off,
    'kpis', v_kpis,
    'rows', COALESCE(v_rows, '[]'::jsonb)
  );
END; $$;

REVOKE ALL ON FUNCTION public.partner_ops_proxy_agent_pv(date, text, text, text, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.partner_ops_proxy_agent_pv(date, text, text, text, integer, integer) TO authenticated;