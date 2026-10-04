-- ============================================
-- Rent Repayment Formula — Single Source of Truth
-- ============================================

-- 1. Canonical formula function
CREATE OR REPLACE FUNCTION public.compute_rent_repayment(
  p_rent_amount numeric,
  p_duration_days integer
)
RETURNS TABLE(
  access_fee numeric,
  request_fee numeric,
  total_repayment numeric,
  daily_repayment numeric
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_access numeric;
  v_reg numeric;
  v_total numeric;
  v_daily numeric;
BEGIN
  IF p_rent_amount IS NULL OR p_rent_amount <= 0 OR p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  -- Access fee = Rent × (1.33^(days/30) - 1), rounded
  v_access := ROUND(p_rent_amount * (POWER(1.33::numeric, (p_duration_days::numeric / 30.0)) - 1));
  -- Registration fee
  v_reg := CASE WHEN p_rent_amount <= 200000 THEN 10000 ELSE 20000 END;
  -- Total repayment
  v_total := p_rent_amount + v_access + v_reg;
  -- Daily payment (ceil)
  v_daily := CEIL(v_total / p_duration_days::numeric);

  RETURN QUERY SELECT v_access, v_reg, v_total, v_daily;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_rent_repayment(numeric, integer) TO anon, authenticated, service_role;

-- 2. Enforcement trigger — overwrite the four fee fields from canonical formula
CREATE OR REPLACE FUNCTION public.enforce_rent_request_formula()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_canon RECORD;
BEGIN
  -- Only enforce when we have the inputs needed
  IF NEW.rent_amount IS NULL OR NEW.rent_amount <= 0
     OR NEW.duration_days IS NULL OR NEW.duration_days <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_canon FROM public.compute_rent_repayment(NEW.rent_amount, NEW.duration_days);

  -- Always overwrite — formula is the source of truth
  NEW.access_fee      := v_canon.access_fee;
  NEW.request_fee     := v_canon.request_fee;
  NEW.total_repayment := v_canon.total_repayment;
  NEW.daily_repayment := v_canon.daily_repayment;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_rent_request_formula ON public.rent_requests;
CREATE TRIGGER trg_enforce_rent_request_formula
  BEFORE INSERT OR UPDATE OF rent_amount, duration_days, access_fee, request_fee, total_repayment, daily_repayment
  ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_rent_request_formula();

-- 3. Drift audit view (existing rows that don't match the formula)
CREATE OR REPLACE VIEW public.rent_request_formula_drift AS
SELECT
  rr.id,
  rr.tenant_id,
  rr.agent_id,
  rr.rent_amount,
  rr.duration_days,
  rr.access_fee       AS stored_access_fee,
  c.access_fee        AS canonical_access_fee,
  rr.request_fee      AS stored_request_fee,
  c.request_fee       AS canonical_request_fee,
  rr.total_repayment  AS stored_total_repayment,
  c.total_repayment   AS canonical_total_repayment,
  rr.daily_repayment  AS stored_daily_repayment,
  c.daily_repayment   AS canonical_daily_repayment,
  (rr.total_repayment - c.total_repayment) AS total_drift_ugx,
  rr.status,
  rr.created_at
FROM public.rent_requests rr
CROSS JOIN LATERAL public.compute_rent_repayment(rr.rent_amount, rr.duration_days) c
WHERE rr.rent_amount IS NOT NULL
  AND rr.duration_days IS NOT NULL
  AND rr.duration_days > 0
  AND (
    ABS(COALESCE(rr.access_fee, 0)      - c.access_fee)      > 1
 OR ABS(COALESCE(rr.request_fee, 0)     - c.request_fee)     > 1
 OR ABS(COALESCE(rr.total_repayment, 0) - c.total_repayment) > 1
 OR ABS(COALESCE(rr.daily_repayment, 0) - c.daily_repayment) > 1
  );

GRANT SELECT ON public.rent_request_formula_drift TO authenticated, service_role;

COMMENT ON FUNCTION public.compute_rent_repayment(numeric, integer) IS
  'Canonical Welile rent repayment formula. Total = Rent * 1.33^(days/30) + RegFee (10k <=200k, 20k >200k). Daily = ceil(Total/days). Single source of truth — do not duplicate this logic anywhere.';

COMMENT ON TRIGGER trg_enforce_rent_request_formula ON public.rent_requests IS
  'BEFORE INSERT/UPDATE — overwrites access_fee, request_fee, total_repayment, daily_repayment with canonical formula values. Client-supplied values for these four fields are silently ignored.';
