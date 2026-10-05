-- tops_shortfall_lines: per-Rent-Plan breakdown of the "pending" (short) figure that
-- ops_tenant_ops_home_range reports as one number. Read-only, additive: one new
-- function, nothing existing is altered.
--
-- Authorization and Kampala-day windowing are copied verbatim from
-- public.ops_tenant_ops_home_range. expected/collected/short use the same
-- definitions as that function's bill_amt / cash / capped CTEs, so
-- SUM(short_ugx) = ops_tenant_ops_home_range(...)->>'pending'.
--
-- Every column reference is alias-qualified on purpose: the RETURNS TABLE output
-- names (rent_request_id, tenant_id, agent_id, ...) are also PL/pgSQL variables,
-- and an unqualified reference raises "column reference is ambiguous".

CREATE OR REPLACE FUNCTION public.tops_shortfall_lines(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  rent_request_id uuid,
  tenant_id uuid,
  agent_id uuid,
  expected_ugx numeric,
  collected_capped_ugx numeric,
  short_ugx numeric,
  collected_raw_ugx numeric,
  last_paid_at timestamptz,
  oldest_unpaid_due date,
  days_behind int,
  cadence text,
  periods_behind int
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_d1 date;
  v_d2 date;
  v_today date;
  v_asof date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';

  v_today := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_d1 := (v_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 := ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, v_today);

  RETURN QUERY
  WITH bill AS (
    SELECT dp.rent_request_id AS rr_id, SUM(dp.expected_ugx) AS expected_ugx
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_d1 AND v_asof
    GROUP BY dp.rent_request_id
  ),
  latest AS (
    SELECT DISTINCT ON (dp.rent_request_id) dp.rent_request_id AS rr_id, dp.agent_id AS ag_id, dp.tenant_id AS tn_id
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_d1 AND v_asof
    ORDER BY dp.rent_request_id, dp.day DESC
  ),
  cash AS (
    SELECT ac.rent_request_id AS rr_id, SUM(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE ac.created_at >= v_start AND ac.created_at < v_end
      AND ac.amount > 0 AND ac.reversed_at IS NULL
      AND ac.rent_request_id IS NOT NULL
    GROUP BY ac.rent_request_id
  ),
  short_plans AS (
    SELECT b.rr_id,
           b.expected_ugx,
           LEAST(COALESCE(c.paid, 0), b.expected_ugx) AS capped,
           COALESCE(c.paid, 0) AS raw_paid
    FROM bill b
    LEFT JOIN cash c ON c.rr_id = b.rr_id
    WHERE b.expected_ugx - LEAST(COALESCE(c.paid, 0), b.expected_ugx) > 0
  ),
  last_paid AS (
    -- As of the window end, so a historical window is not polluted by later payments.
    SELECT ac.rent_request_id AS rr_id, MAX(ac.created_at) AS last_paid_at
    FROM public.agent_collections ac
    WHERE ac.created_at < v_end
      AND ac.amount > 0 AND ac.reversed_at IS NULL
      AND ac.rent_request_id IN (SELECT sp.rr_id FROM short_plans sp)
    GROUP BY ac.rent_request_id
  ),
  behind AS (
    SELECT oi.rent_request_id AS rr_id, MIN(oi.due_date) AS oldest_due
    FROM public.tops_open_instalments_asof(v_asof) oi
    WHERE NOT oi.never_billed AND oi.outstanding_ugx > 0
    GROUP BY oi.rent_request_id
  )
  SELECT
    sp.rr_id,
    l.tn_id,
    l.ag_id,
    sp.expected_ugx,
    sp.capped,
    sp.expected_ugx - sp.capped,
    sp.raw_paid,
    lp.last_paid_at,
    bh.oldest_due,
    (v_asof - bh.oldest_due)::int,
    rr.repayment_frequency,
    CASE
      WHEN bh.oldest_due IS NULL THEN NULL
      WHEN rr.repayment_frequency = 'daily' THEN (v_asof - bh.oldest_due)::int
      WHEN rr.repayment_frequency = 'weekly' THEN ceil((v_asof - bh.oldest_due)::numeric / 7)::int
      WHEN rr.repayment_frequency = 'monthly' THEN ceil((v_asof - bh.oldest_due)::numeric / 30)::int
      ELSE NULL
    END
  FROM short_plans sp
  JOIN latest l ON l.rr_id = sp.rr_id
  LEFT JOIN public.rent_requests rr ON rr.id = sp.rr_id
  LEFT JOIN last_paid lp ON lp.rr_id = sp.rr_id
  LEFT JOIN behind bh ON bh.rr_id = sp.rr_id
  ORDER BY (sp.expected_ugx - sp.capped) DESC, sp.rr_id;
END;
$function$;

-- This schema's default privileges auto-grant new functions to anon; revoke explicitly.
REVOKE ALL ON FUNCTION public.tops_shortfall_lines(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_shortfall_lines(timestamptz, timestamptz) TO authenticated;
