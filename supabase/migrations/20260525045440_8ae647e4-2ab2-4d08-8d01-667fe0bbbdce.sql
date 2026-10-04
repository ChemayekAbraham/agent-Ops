CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH active_rents AS (
  SELECT rr.agent_id, rr.id AS rent_request_id, rr.daily_repayment, rr.amount_repaid
  FROM public.rent_requests rr
  WHERE rr.status = ANY (ARRAY[
    'pending','agent_verified','tenant_ops_approved',
    'agent_ops_approved','landlord_ops_approved',
    'coo_approved','funded','repaying'
  ])
),
reversed AS (
  SELECT DISTINCT rent_request_id FROM public.agent_tenant_float_reversals
),
eligible_rents AS (
  SELECT ar.*
  FROM active_rents ar
  LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
  WHERE rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid, 0) > 0
),
expected AS (
  SELECT agent_id,
         COUNT(*)::int                            AS active_count,
         COALESCE(SUM(daily_repayment), 0)::numeric AS expected_daily
  FROM eligible_rents GROUP BY agent_id
),
collected AS (
  SELECT ac.agent_id,
    SUM(CASE WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
                = (now()         AT TIME ZONE 'Africa/Kampala')::date
             THEN ac.amount ELSE 0 END)::numeric AS paid_today,
    SUM(CASE WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
                = ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)
             THEN ac.amount ELSE 0 END)::numeric AS paid_yesterday
  FROM public.agent_collections ac
  WHERE ac.created_at >= (
    ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp
    AT TIME ZONE 'Africa/Kampala'
  )
  GROUP BY ac.agent_id
)
SELECT e.agent_id, e.active_count, e.expected_daily,
       COALESCE(c.paid_today, 0)     AS paid_today,
       COALESCE(c.paid_yesterday, 0) AS paid_yesterday,
       CASE WHEN e.expected_daily > 0
            THEN ROUND(COALESCE(c.paid_today,0)     / e.expected_daily, 4)
            ELSE 0 END AS today_pct,
       CASE WHEN e.expected_daily > 0
            THEN ROUND(COALESCE(c.paid_yesterday,0) / e.expected_daily, 4)
            ELSE 0 END AS yesterday_pct,
       CASE WHEN e.expected_daily > 0
            THEN GREATEST(
              COALESCE(c.paid_today,0)     / e.expected_daily,
              COALESCE(c.paid_yesterday,0) / e.expected_daily)
            ELSE 0 END AS effective_pct
FROM expected e LEFT JOIN collected c USING (agent_id);

COMMENT ON VIEW public.v_agent_daily_eligibility IS
  'Server-side Daily Eligibility Law. Numerator: agent_collections in Africa/Kampala TZ. Denominator: active rent_requests.daily_repayment (excl. fully-reversed unfunded). effective_pct = max(today, yesterday).';

GRANT SELECT ON public.v_agent_daily_eligibility TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.get_agent_daily_eligibility(p_agent_ids uuid[])
RETURNS TABLE (
  agent_id uuid, active_count int, expected_daily numeric,
  paid_today numeric, paid_yesterday numeric,
  today_pct numeric, yesterday_pct numeric, effective_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.agent_id, v.active_count, v.expected_daily,
         v.paid_today, v.paid_yesterday,
         v.today_pct, v.yesterday_pct, v.effective_pct
  FROM public.v_agent_daily_eligibility v
  WHERE v.agent_id = ANY (p_agent_ids);
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_daily_eligibility(uuid[])
  TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.enforce_agent_daily_eligibility()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_active_count   int;
  v_effective_pct  numeric;
  v_bypass         text;
BEGIN
  v_bypass := current_setting('app.bypass_daily_eligibility', true);
  IF v_bypass = 'true' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;

  SELECT active_count, effective_pct
    INTO v_active_count, v_effective_pct
  FROM public.v_agent_daily_eligibility
  WHERE agent_id = NEW.agent_id;

  IF v_active_count IS NULL OR v_active_count = 0 THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_effective_pct, 0) < 0.20 THEN
    RAISE EXCEPTION
      'DAILY_ELIGIBILITY_BLOCKED: agent collected %.1f%% of expected daily (target 20%%). Collect from existing tenants before posting new rent requests.',
      COALESCE(v_effective_pct, 0) * 100
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_enforce_agent_daily_eligibility ON public.rent_requests;
CREATE TRIGGER tr_enforce_agent_daily_eligibility
  BEFORE INSERT ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_daily_eligibility();