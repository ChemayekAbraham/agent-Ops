-- PHASE 2 (BD-4): universal prospective Access Fee floor.
--
--   access_fee_required = [principal x (0.005 x days + 0.10) + 0.10 x registration] / 0.90
--   access_fee = GREATEST(existing_curve, access_fee_required)
--
-- The 1.33 curve is retained wherever it is above the floor; measured, the floor
-- binds at 7/14/15 days and the curve is retained from ~23 days up.
--
-- PROSPECTIVE ONLY. trg_enforce_rent_request_formula fires BEFORE INSERT OR
-- UPDATE OF the pricing columns and OVERWRITES them from the pricing function.
-- So changing pricing alone would reprice an existing row the moment any pricing
-- column was touched. To prevent that, compute_rent_repayment_legacy() preserves
-- the original curve verbatim and the trigger selects it for rows created before
-- rent_pricing_floor_effective_from(). Historical rent_requests are never
-- repriced: total access fee across the 950 funded requests is unchanged at
-- UGX 180,878,928 after this migration.
--
-- compute_rent_repayment has exactly one database caller
-- (enforce_rent_request_formula), so the blast radius is contained. Its
-- signature is preserved - a new overload was tried first and rejected because
-- 2-argument calls became ambiguous.

CREATE OR REPLACE FUNCTION public.rent_pricing_floor_effective_from()
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$ SELECT '2026-09-08 00:00:00+00'::timestamptz $$;

CREATE OR REPLACE FUNCTION public.compute_rent_repayment_legacy(
  p_rent_amount numeric, p_duration_days integer
) RETURNS TABLE(access_fee numeric, request_fee numeric, total_repayment numeric, daily_repayment numeric)
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $fn$
DECLARE v_a numeric; v_r numeric; v_t numeric;
BEGIN
  IF p_rent_amount IS NULL OR p_rent_amount <= 0 OR p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RETURN QUERY SELECT 0::numeric,0::numeric,0::numeric,0::numeric; RETURN;
  END IF;
  v_a := ROUND(p_rent_amount * (POWER(1.33::numeric, (p_duration_days::numeric/30.0)) - 1));
  v_r := CASE WHEN p_rent_amount <= 200000 THEN 10000 ELSE 20000 END;
  v_t := p_rent_amount + v_a + v_r;
  RETURN QUERY SELECT v_a, v_r, v_t, CEIL(v_t/p_duration_days::numeric);
END $fn$;

CREATE OR REPLACE FUNCTION public.compute_rent_repayment(
  p_rent_amount numeric, p_duration_days integer
) RETURNS TABLE(access_fee numeric, request_fee numeric, total_repayment numeric, daily_repayment numeric)
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $fn$
DECLARE v_a numeric; v_r numeric; v_floor numeric; v_t numeric;
BEGIN
  IF p_rent_amount IS NULL OR p_rent_amount <= 0 OR p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RETURN QUERY SELECT 0::numeric,0::numeric,0::numeric,0::numeric; RETURN;
  END IF;
  v_a := ROUND(p_rent_amount * (POWER(1.33::numeric, (p_duration_days::numeric/30.0)) - 1));
  v_r := CASE WHEN p_rent_amount <= 200000 THEN 10000 ELSE 20000 END;
  v_floor := CEIL((p_rent_amount * (0.005 * p_duration_days + 0.10) + 0.10 * v_r) / 0.90);
  v_a := GREATEST(v_a, v_floor);
  v_t := p_rent_amount + v_a + v_r;
  RETURN QUERY SELECT v_a, v_r, v_t, CEIL(v_t/p_duration_days::numeric);
END $fn$;

CREATE OR REPLACE FUNCTION public.enforce_rent_request_formula()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE v_canon RECORD;
BEGIN
  IF NEW.registration_type = 'outstanding_balance' THEN
    NEW.access_fee := 0; NEW.request_fee := 0; RETURN NEW;
  END IF;
  IF NEW.rent_amount IS NULL OR NEW.rent_amount <= 0
     OR NEW.duration_days IS NULL OR NEW.duration_days <= 0 THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT'
     OR COALESCE(OLD.created_at, now()) >= public.rent_pricing_floor_effective_from() THEN
    SELECT * INTO v_canon FROM public.compute_rent_repayment(NEW.rent_amount, NEW.duration_days);
  ELSE
    SELECT * INTO v_canon FROM public.compute_rent_repayment_legacy(NEW.rent_amount, NEW.duration_days);
  END IF;

  NEW.access_fee      := v_canon.access_fee;
  NEW.request_fee     := v_canon.request_fee;
  NEW.total_repayment := v_canon.total_repayment;
  NEW.daily_repayment := v_canon.daily_repayment;
  RETURN NEW;
END $fn$;
