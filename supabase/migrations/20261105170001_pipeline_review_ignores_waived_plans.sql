-- The Landlord Ops / Tenant Ops review must not judge a tenant on a CFO-waived Rent Plan (docs 254-258).
--
-- WHAT WAS WRONG
-- Nakitende Jumeirah's renewal request (51ecc2d8, posted 2026-11-05) could not pass review:
-- * _pipeline_auto_checks, check 'ao_tenant_ok', rates the tenant on sum(amount_repaid)/sum(total_repayment)
--   of her earlier plans in the last 180 days and FAILS below 60%. The waived plan 406ed7bc counts as
--   216,000 of 552,000 repaid, so (216,000 + 90,000) / (552,000 + 90,000) = 48% -> 'fail'.
-- * rent_pipeline_tenant_history (the tenant history / repayment-rate label on the dashboards) counts the
--   same plan as fully expected but only 216,000 repaid, so her classification and rate read poor.
-- This is the same flaw as get_agent_rent_request_capacity (doc 255).
--
-- THE FIX (same marker as docs 255/256/258): a plan carrying an audit_logs row
-- action_type LIKE 'rent_plan_balance_waived%' is left out of the repayment rate.
-- * _pipeline_auto_checks: the plan is excluded from the 180-day sum.
-- * rent_pipeline_tenant_history: the plan's expected_to_date becomes 0, so it adds nothing to
--   expected or to repaid-against-expected; it still counts as a funded/completed plan in the history.
-- Both functions are patched IN PLACE from their live definitions (no body retyped); each patch aborts the
-- whole migration if its anchor text is not found exactly once. CREATE OR REPLACE keeps grants.

DO $$
DECLARE
  v_oid   oid;
  v_def   text;
  v_count integer;
  v_a1    constant text := 'and x.created_at >= now() - interval ''180 days'';';
  v_a1new constant text := 'and x.created_at >= now() - interval ''180 days'''
    || chr(10) || '     and not exists (select 1 from public.audit_logs al where al.table_name = ''rent_requests'' and al.record_id = x.id::text and al.action_type like ''rent_plan_balance_waived%'');';
  v_a2    constant text := 'WHEN NOT p.was_funded OR p.starts_on IS NULL OR p.starts_on > v_today THEN 0';
  v_a2new constant text := 'WHEN NOT p.was_funded OR p.starts_on IS NULL OR p.starts_on > v_today'
    || chr(10) || '          OR EXISTS (SELECT 1 FROM public.audit_logs al WHERE al.table_name = ''rent_requests'' AND al.record_id = p.id::text AND al.action_type LIKE ''rent_plan_balance_waived%'') THEN 0';
BEGIN
  -- 1. _pipeline_auto_checks(uuid)
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '_pipeline_auto_checks';
  v_def := pg_get_functiondef(v_oid);
  IF position('rent_plan_balance_waived' IN v_def) > 0 THEN
    RAISE NOTICE '_pipeline_auto_checks already patched; skipping';
  ELSE
    v_count := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
    IF v_count <> 1 THEN RAISE EXCEPTION '_pipeline_auto_checks anchor found % times, expected 1; aborting', v_count; END IF;
    EXECUTE replace(v_def, v_a1, v_a1new);
  END IF;

  -- 2. rent_pipeline_tenant_history(uuid, uuid)
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rent_pipeline_tenant_history';
  v_def := pg_get_functiondef(v_oid);
  IF position('rent_plan_balance_waived' IN v_def) > 0 THEN
    RAISE NOTICE 'rent_pipeline_tenant_history already patched; skipping';
  ELSE
    v_count := (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2);
    IF v_count <> 1 THEN RAISE EXCEPTION 'rent_pipeline_tenant_history anchor found % times, expected 1; aborting', v_count; END IF;
    EXECUTE replace(v_def, v_a2, v_a2new);
  END IF;
END $$;
