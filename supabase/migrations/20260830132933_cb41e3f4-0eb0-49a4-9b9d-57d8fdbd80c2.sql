CREATE TABLE IF NOT EXISTS public.proxy_agent_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key text NOT NULL CHECK (metric_key IN ('partners_came_in','notes_activated','capital_raised')),
  period_month date NOT NULL,
  target_value numeric NOT NULL CHECK (target_value > 0),
  note text,
  set_by uuid NOT NULL DEFAULT auth.uid(),
  set_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proxy_agent_targets_unique UNIQUE (metric_key, period_month)
);

GRANT SELECT, INSERT, UPDATE ON public.proxy_agent_targets TO authenticated;
GRANT ALL ON public.proxy_agent_targets TO service_role;

ALTER TABLE public.proxy_agent_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pat_select ON public.proxy_agent_targets;
CREATE POLICY pat_select ON public.proxy_agent_targets FOR SELECT TO authenticated
USING (public.is_partner_ops(auth.uid()));

DROP POLICY IF EXISTS pat_insert ON public.proxy_agent_targets;
CREATE POLICY pat_insert ON public.proxy_agent_targets FOR INSERT TO authenticated
WITH CHECK (public.is_partner_ops(auth.uid()));

DROP POLICY IF EXISTS pat_update ON public.proxy_agent_targets;
CREATE POLICY pat_update ON public.proxy_agent_targets FOR UPDATE TO authenticated
USING (public.is_partner_ops(auth.uid()));

CREATE OR REPLACE FUNCTION public.partner_ops_set_proxy_agent_target(
  p_metric_key text,
  p_month date,
  p_target numeric,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_month date := date_trunc('month', COALESCE(p_month, current_date))::date;
  v_id uuid;
BEGIN
  IF NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_metric_key NOT IN ('partners_came_in','notes_activated','capital_raised') THEN
    RAISE EXCEPTION 'Unknown target metric';
  END IF;
  IF COALESCE(p_target,0) <= 0 THEN
    RAISE EXCEPTION 'Target must be greater than zero';
  END IF;

  INSERT INTO public.proxy_agent_targets (metric_key, period_month, target_value, note, set_by, set_at)
  VALUES (p_metric_key, v_month, p_target, NULLIF(btrim(COALESCE(p_note,'')),''), auth.uid(), now())
  ON CONFLICT (metric_key, period_month) DO UPDATE
    SET target_value = EXCLUDED.target_value,
        note = EXCLUDED.note,
        set_by = EXCLUDED.set_by,
        set_at = now()
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES ('proxy_agent_target_set', 'proxy_agent_targets', v_id, auth.uid(),
          'Partner Ops set the monthly proxy agent target',
          jsonb_build_object('metric_key', p_metric_key, 'period_month', v_month, 'target_value', p_target, 'note', p_note));

  RETURN jsonb_build_object('id', v_id, 'metric_key', p_metric_key, 'period_month', v_month, 'target_value', p_target);
END;
$$;

REVOKE ALL ON FUNCTION public.partner_ops_set_proxy_agent_target(text, date, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_ops_set_proxy_agent_target(text, date, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.partner_ops_proxy_agent_target_overview(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_start date := date_trunc('month', COALESCE(p_month, current_date))::date;
  v_end date := (v_start + interval '1 month')::date;
  v_agents int;
  v_targets jsonb;
  v_metrics jsonb;
BEGIN
  IF NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COUNT(*)::int INTO v_agents
    FROM public.proxy_agent_identity i
   WHERE i.status = 'approved';

  SELECT COALESCE(jsonb_object_agg(t.metric_key, jsonb_build_object(
           'target_value', t.target_value, 'note', t.note, 'set_at', t.set_at)), '{}'::jsonb)
    INTO v_targets
    FROM public.proxy_agent_targets t
   WHERE t.period_month = v_start;

  WITH per_agent AS (
    SELECT i.agent_user_id AS aid,
           COALESCE(pf.came_in, 0)::numeric AS partners_came_in,
           COALESCE(pf.funded, 0)::numeric AS capital_raised,
           COALESCE(nt.activated, 0)::numeric AS notes_activated
      FROM public.proxy_agent_identity i
      LEFT JOIN (
        SELECT ip.agent_id AS aid,
               COUNT(DISTINCT ip.investor_id)::int AS came_in,
               COALESCE(SUM(ip.investment_amount),0) AS funded
          FROM public.investor_portfolios ip
         WHERE ip.agent_id IS NOT NULL
           AND ip.created_at >= v_start AND ip.created_at < v_end
         GROUP BY 1
      ) pf ON pf.aid = i.agent_user_id
      LEFT JOIN (
        SELECT pn.agent_id AS aid, COUNT(*)::int AS activated
          FROM public.promissory_notes pn
         WHERE pn.status = 'activated'
           AND COALESCE(pn.approved_at, pn.created_at) >= v_start
           AND COALESCE(pn.approved_at, pn.created_at) < v_end
         GROUP BY 1
      ) nt ON nt.aid = i.agent_user_id
     WHERE i.status = 'approved'
  )
  SELECT jsonb_build_object(
    'partners_came_in', jsonb_build_object(
      'achieved_total', COALESCE(SUM(partners_came_in),0),
      'started', COUNT(*) FILTER (WHERE partners_came_in > 0)::int,
      'hit', COUNT(*) FILTER (WHERE partners_came_in >= COALESCE((v_targets->'partners_came_in'->>'target_value')::numeric, 'Infinity'))::int),
    'notes_activated', jsonb_build_object(
      'achieved_total', COALESCE(SUM(notes_activated),0),
      'started', COUNT(*) FILTER (WHERE notes_activated > 0)::int,
      'hit', COUNT(*) FILTER (WHERE notes_activated >= COALESCE((v_targets->'notes_activated'->>'target_value')::numeric, 'Infinity'))::int),
    'capital_raised', jsonb_build_object(
      'achieved_total', COALESCE(SUM(capital_raised),0),
      'started', COUNT(*) FILTER (WHERE capital_raised > 0)::int,
      'hit', COUNT(*) FILTER (WHERE capital_raised >= COALESCE((v_targets->'capital_raised'->>'target_value')::numeric, 'Infinity'))::int)
  ) INTO v_metrics
  FROM per_agent;

  RETURN jsonb_build_object(
    'period_month', v_start,
    'agents_total', COALESCE(v_agents,0),
    'targets', v_targets,
    'metrics', COALESCE(v_metrics, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_ops_proxy_agent_target_overview(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_ops_proxy_agent_target_overview(date) TO authenticated;

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_agent_created ON public.investor_portfolios (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_promissory_notes_agent_status_approved ON public.promissory_notes (agent_id, status, approved_at);