-- Tenant Payment Behavior: the three read-only building blocks every other
-- tops_payment_behaviour_* function sits on. Additive: new functions only, nothing
-- existing is altered and no table is written.
--
-- How self-payments are told apart from agent payments (authoritative, checked live):
--   agent_collections.collection_channel
--     'tenant_deposit_auto'        the tenant paid from their own number; settle_tenant_rent_from_
--                                  deposit() wrote the receipt (initiated_by = the tenant on every
--                                  row; row-for-row equal to tenant_self_repayment_attempts with
--                                  outcome 'settled', 137 rows / UGX 1,760,931 at build time)  -> self
--     'agent_float'                the agent spent their own float to settle the tenant's rent
--                                  (cash entered by the agent)                                 -> agent
--     anything else                ('agent_liability_settlement', one row)                      -> other
-- Reversed collections (reversed_at IS NOT NULL), zero amounts and receipts without a Rent Plan
-- are excluded everywhere, and the collection day is an Africa/Kampala date, exactly as in
-- tops_shortfall_lines. Agent and place are attributed from the Rent Plan (rent_requests.agent_id,
-- v_tlb_tenant_base), the same attribution the daily bill uses.
--
-- Every function carries the same role check as the shortfall functions, is SECURITY DEFINER with
-- search_path = public, and is revoked from PUBLIC and anon. Column references are alias-qualified
-- and the output columns carry prefixes because RETURNS TABLE names are also PL/pgSQL variables.

-- ─── tops_pay_behaviour_scope: the Rent Plans a filter selects ──────────────────

DROP FUNCTION IF EXISTS public.tops_pay_behaviour_plans(timestamptz, timestamptz, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.tops_pay_behaviour_payments(timestamptz, timestamptz, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.tops_pay_behaviour_scope(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.tops_pay_behaviour_scope(
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS TABLE (
  sc_rr uuid,
  sc_tenant uuid,
  sc_agent uuid,
  sc_cadence text,
  sc_rent numeric,
  sc_start date,
  sc_status text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  -- The place view is the slow part of this query (about 75 ms), so it is only joined when a
  -- region or district filter is actually given. Breakdowns by place join it themselves.
  IF p_region IS NULL AND p_district IS NULL THEN
    RETURN QUERY
    SELECT rr.id, rr.tenant_id, rr.agent_id, rr.repayment_frequency, rr.rent_amount,
           COALESCE(rr.repayment_starts_on, rr.funded_at::date, rr.created_at::date), rr.status
    FROM public.rent_requests rr
    WHERE rr.tenant_id IS NOT NULL
      AND (p_agent_id IS NULL OR rr.agent_id = p_agent_id)
      AND (p_cadence IS NULL OR rr.repayment_frequency = p_cadence);
  ELSE
    RETURN QUERY
    SELECT rr.id, rr.tenant_id, rr.agent_id, rr.repayment_frequency, rr.rent_amount,
           COALESCE(rr.repayment_starts_on, rr.funded_at::date, rr.created_at::date), rr.status
    FROM public.rent_requests rr
    JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr.tenant_id
    WHERE rr.tenant_id IS NOT NULL
      AND (p_agent_id IS NULL OR rr.agent_id = p_agent_id)
      AND (p_region IS NULL OR tb.region = p_region)
      AND (p_district IS NULL OR tb.district_name = p_district)
      AND (p_cadence IS NULL OR rr.repayment_frequency = p_cadence);
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_pay_behaviour_scope(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pay_behaviour_scope(uuid, text, text, text) TO authenticated;

-- ─── tops_pay_behaviour_payments: every valid payment in the window, by who paid ─

CREATE OR REPLACE FUNCTION public.tops_pay_behaviour_payments(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS TABLE (
  pay_id uuid,
  pay_rr uuid,
  pay_tenant uuid,
  pay_agent uuid,
  pay_channel text,
  pay_amount numeric,
  pay_at timestamptz,
  pay_day date,
  pay_hour int,
  pay_dow int
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';

  RETURN QUERY
  SELECT
    ac.id,
    ac.rent_request_id,
    sc.sc_tenant,
    sc.sc_agent,
    CASE ac.collection_channel
      WHEN 'tenant_deposit_auto' THEN 'self'
      WHEN 'agent_float' THEN 'agent'
      ELSE 'other'
    END,
    ac.amount,
    ac.created_at,
    (ac.created_at AT TIME ZONE 'Africa/Kampala')::date,
    extract(hour FROM ac.created_at AT TIME ZONE 'Africa/Kampala')::int,
    extract(isodow FROM ac.created_at AT TIME ZONE 'Africa/Kampala')::int
  FROM public.agent_collections ac
  JOIN public.tops_pay_behaviour_scope(p_agent_id, p_region, p_district, p_cadence) sc ON sc.sc_rr = ac.rent_request_id
  WHERE ac.created_at >= v_start AND ac.created_at < v_end
    AND ac.amount > 0 AND ac.reversed_at IS NULL
    AND ac.rent_request_id IS NOT NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_pay_behaviour_payments(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pay_behaviour_payments(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;

-- ─── tops_pay_behaviour_plans: one row per Rent Plan billed or paid in the window ─

CREATE OR REPLACE FUNCTION public.tops_pay_behaviour_plans(
  p_start timestamptz,
  p_end timestamptz,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL
)
RETURNS TABLE (
  pl_rr uuid,
  pl_tenant uuid,
  pl_agent uuid,
  pl_cadence text,
  pl_rent numeric,
  pl_start date,
  pl_billed_days int,
  pl_billed_ugx numeric,
  pl_paid_ugx numeric,
  pl_self_ugx numeric,
  pl_agent_ugx numeric,
  pl_other_ugx numeric,
  pl_self_n int,
  pl_agent_n int,
  pl_other_n int,
  pl_paid_days int,
  pl_first_paid timestamptz,
  pl_last_paid timestamptz,
  pl_covered_ugx numeric,
  pl_segment text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d1 date;
  v_d2 date;
  v_asof date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_d1 := (p_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 := (p_end AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, (now() AT TIME ZONE 'Africa/Kampala')::date);

  RETURN QUERY
  WITH sc AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_scope(p_agent_id, p_region, p_district, p_cadence)
  ),
  bill AS (
    SELECT dp.rent_request_id AS rr_id,
           count(DISTINCT dp.day) FILTER (WHERE dp.expected_ugx > 0)::int AS billed_days,
           SUM(dp.expected_ugx) AS billed_ugx
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_d1 AND v_asof
      AND dp.rent_request_id IN (SELECT s0.sc_rr FROM sc s0)
    GROUP BY dp.rent_request_id
  ),
  pay AS (
    SELECT p.pay_rr AS rr_id,
           SUM(p.pay_amount) AS paid_ugx,
           SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'self') AS self_ugx,
           SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'agent') AS agent_ugx,
           SUM(p.pay_amount) FILTER (WHERE p.pay_channel = 'other') AS other_ugx,
           count(*) FILTER (WHERE p.pay_channel = 'self')::int AS self_n,
           count(*) FILTER (WHERE p.pay_channel = 'agent')::int AS agent_n,
           count(*) FILTER (WHERE p.pay_channel = 'other')::int AS other_n,
           count(DISTINCT p.pay_day)::int AS paid_days,
           MIN(p.pay_at) AS first_paid,
           MAX(p.pay_at) AS last_paid
    FROM public.tops_pay_behaviour_payments(p_start, p_end, p_agent_id, p_region, p_district, p_cadence) p
    GROUP BY p.pay_rr
  )
  SELECT
    s.sc_rr,
    s.sc_tenant,
    s.sc_agent,
    s.sc_cadence,
    s.sc_rent,
    s.sc_start,
    COALESCE(b.billed_days, 0),
    COALESCE(b.billed_ugx, 0),
    COALESCE(y.paid_ugx, 0),
    COALESCE(y.self_ugx, 0),
    COALESCE(y.agent_ugx, 0),
    COALESCE(y.other_ugx, 0),
    COALESCE(y.self_n, 0),
    COALESCE(y.agent_n, 0),
    COALESCE(y.other_n, 0),
    COALESCE(y.paid_days, 0),
    y.first_paid,
    y.last_paid,
    LEAST(COALESCE(y.paid_ugx, 0), COALESCE(b.billed_ugx, 0)),
    CASE
      WHEN COALESCE(y.self_n, 0) > 0 AND COALESCE(y.agent_n, 0) > 0 THEN 'mixed'
      WHEN COALESCE(y.self_n, 0) > 0 THEN 'self_only'
      WHEN COALESCE(y.agent_n, 0) > 0 THEN 'agent_only'
      ELSE 'no_payment'
    END
  FROM sc s
  LEFT JOIN bill b ON b.rr_id = s.sc_rr
  LEFT JOIN pay y ON y.rr_id = s.sc_rr
  WHERE b.rr_id IS NOT NULL OR y.rr_id IS NOT NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_pay_behaviour_plans(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pay_behaviour_plans(timestamptz, timestamptz, uuid, text, text, text) TO authenticated;
