-- A CFO-waived Rent Plan must not show as owing in two more places (docs 254-257).
--
-- WHAT WAS STILL WRONG (found 2026-11-05, after 256 fixed the other Landlord Ops RPCs)
-- 1. landlord_hub_detail (Landlord Ops calling hub, "tenants_and_plans") computes each plan's
--    'outstanding' as total_repayment - amount_repaid for any plan not rejected/cancelled, so
--    Nakitende Jumeirah's completed + waived plan 406ed7bc still read 336,000.
-- 2. v_rent_plan_expired_owing (read only by agent_expired_cycles, the agent's expired-cycles list)
--    has no closed-plan test, so the same plan still read 336,000 outstanding, 68 days overdue,
--    to the agent now handling the tenant.
--
-- THE FIX (same marker as docs 255/256): a plan carrying an audit_logs row
-- action_type LIKE 'rent_plan_balance_waived%' owes 0. Nothing else changes.
-- Both objects are patched IN PLACE from their live definitions, so no body is retyped; each patch
-- aborts the whole migration if its anchor text is not found exactly once. Grants are kept
-- (CREATE OR REPLACE FUNCTION; the view has no options and no dependents).
-- Not status-based on purpose: six plans closed `completed` with a shortfall on 2026-09-04 (about
-- 2.2M) are not waived and keep their current display until the CFO decides.

DO $$
DECLARE
  v_def   text;
  v_new   text;
  v_old   constant text := 'ELSE GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0)';
  v_add   constant text := 'WHEN EXISTS (SELECT 1 FROM public.audit_logs al WHERE al.table_name = ''rent_requests'' AND al.record_id = rr.id::text AND al.action_type LIKE ''rent_plan_balance_waived%'') THEN 0::numeric' || chr(10) || '          ';
  v_count integer;
BEGIN
  -- 1. landlord_hub_detail
  v_def := pg_get_functiondef('public.landlord_hub_detail(text)'::regprocedure);
  IF position('rent_plan_balance_waived' IN v_def) > 0 THEN
    RAISE NOTICE 'landlord_hub_detail already patched; skipping';
  ELSE
    v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'landlord_hub_detail anchor found % times, expected 1; aborting without changes', v_count;
    END IF;
    v_new := replace(v_def, v_old, v_add || v_old);
    EXECUTE v_new;
  END IF;

  -- 2. v_rent_plan_expired_owing
  v_def := pg_get_viewdef('public.v_rent_plan_expired_owing'::regclass, true);
  IF position('rent_plan_balance_waived' IN v_def) > 0 THEN
    RAISE NOTICE 'v_rent_plan_expired_owing already patched; skipping';
  ELSE
    v_count := (length(v_def) - length(replace(v_def, 'WHERE s.obligation_end < t.today AND', ''))) / length('WHERE s.obligation_end < t.today AND');
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'v_rent_plan_expired_owing anchor found % times, expected 1; aborting without changes', v_count;
    END IF;
    v_new := replace(v_def, 'WHERE s.obligation_end < t.today AND',
      'WHERE NOT EXISTS (SELECT 1 FROM public.audit_logs al WHERE al.table_name = ''rent_requests'' AND al.record_id = rr.id::text AND al.action_type LIKE ''rent_plan_balance_waived%'') AND s.obligation_end < t.today AND');
    EXECUTE 'CREATE OR REPLACE VIEW public.v_rent_plan_expired_owing AS ' || v_new;
  END IF;
END $$;
