-- PHASE 2 HARDENING: one authoritative go-live boundary.
--
-- PREPARED, NOT APPLIED.
--
-- THE DEFECT THIS FIXES
-- The effective date 2026-09-08 00:00:00+00 was hard-coded in TWO independent
-- places:
--   20260908100000_bd4_prospective_access_fee_floor.sql:25
--       rent_pricing_floor_effective_from()      [APPLIED to production]
--   20260908130000_option_b_golive_scope.sql:35
--       treasury_waterfall_go_live()             [not applied]
--
-- These must never drift. If the pricing floor activated at a different instant
-- from the Treasury waterfall, a request could be priced BELOW the BD-4 floor and
-- still enter the waterfall - which is precisely the condition that produces
-- negative Treasury and generated the BD-3 subsidy in the first place.
--
-- Both now delegate to a single immutable control value. The approved effective
-- date is UNCHANGED: 2026-09-08 00:00:00+00.
--
-- The two existing functions are retained as thin delegates rather than dropped,
-- so callers already referencing them (the pricing trigger references
-- rent_pricing_floor_effective_from) keep working with no signature change.
--
-- VERIFIED IN A ROLLED-BACK TRANSACTION:
--   rent_pricing_floor_effective_from() = 2026-09-08 00:00:00+00
--   treasury_waterfall_go_live()        = 2026-09-08 00:00:00+00
--   identical = true

CREATE OR REPLACE FUNCTION public.treasury_waterfall_go_live_at()
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$ SELECT '2026-09-08 00:00:00+00'::timestamptz $$;

COMMENT ON FUNCTION public.treasury_waterfall_go_live_at() IS
  'SINGLE AUTHORITATIVE go-live boundary for the Landlord Flow Treasury redesign. '
  'Governs BOTH the BD-4 prospective Access Fee floor and the Treasury waterfall scope. '
  'They must never diverge: a request priced below the floor must never enter the waterfall.';

CREATE OR REPLACE FUNCTION public.rent_pricing_floor_effective_from()
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$ SELECT public.treasury_waterfall_go_live_at() $$;

CREATE OR REPLACE FUNCTION public.treasury_waterfall_go_live()
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$ SELECT public.treasury_waterfall_go_live_at() $$;

-- Scope predicate re-stated against the single boundary. NULL funded_at is
-- treated as LEGACY explicitly and deliberately: 20 rows carry a funded status
-- with no funding timestamp (all 20 still outstanding, 6 with fees > 0), and
-- NULL >= x evaluates to NULL rather than false, so an implicit comparison would
-- silently misclassify them.
CREATE OR REPLACE FUNCTION public.is_treasury_waterfall_scope(p_rent_request_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $fn$
DECLARE v_funded timestamptz; v_fees numeric;
BEGIN
  SELECT funded_at, COALESCE(access_fee,0) + COALESCE(request_fee,0)
    INTO v_funded, v_fees
  FROM rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_funded IS NULL THEN RETURN false; END IF;
  IF v_funded < public.treasury_waterfall_go_live_at() THEN RETURN false; END IF;
  RETURN v_fees > 0;
END $fn$;
