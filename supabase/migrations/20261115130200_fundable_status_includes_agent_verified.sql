-- A released Rent Plan in agent_verified never flipped to funded.
-- v_partner_self_fundable_plans already lists agent_verified. The disbursement
-- updates in psm_disburse_landlord_float and _co_support_disburse_landlord_float
-- did not. This adds that status and leaves every other status in the list.
-- The live bodies are the ones in 20261115090000. Only the status list changes.
--
-- This file is not applied by the pull request.

DO $patch$
DECLARE
  r record;
  src text;
  needle text := '''tenant_ops_approved'',''landlord_ops_approved'',''cfo_approved''';
  repl text := '''tenant_ops_approved'',''landlord_ops_approved'',''agent_verified'',''cfo_approved''';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('psm_disburse_landlord_float', '_co_support_disburse_landlord_float')
  LOOP
    src := pg_get_functiondef(r.sig);
    IF position(needle IN src) = 0 THEN
      RAISE EXCEPTION 'funded status list not found in %', r.sig;
    END IF;
    EXECUTE replace(src, needle, repl);
  END LOOP;
END
$patch$;
