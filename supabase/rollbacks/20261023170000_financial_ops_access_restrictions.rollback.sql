-- Removes the Financial Ops access restrictions: policies, functions and (optionally) the table.
DO $pol$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gmail_transactions','gmail_poll_state','email_routing_history','email_match_audit_log','email_credit_manual_marks',
                           'merchant_float_deliveries','merchant_float_reconciliations','merchant_float_requisitions','merchant_float_variance_alerts','operational_float_audit_log']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN EXECUTE format('DROP POLICY IF EXISTS financial_ops_area_blocked ON public.%I', t); END IF;
  END LOOP;
END
$pol$;

-- Takes the check back out of the six functions (removes the line the migration added right after BEGIN).
DO $guard$
DECLARE v_def text; v_new text; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['get_all_merchant_float_positions','get_merchant_float_positions','get_merchant_float_positions_signed',
                           'get_merchant_float_ledger_variance','get_merchant_float_email_movements','get_gmail_intake_health']
  LOOP
    FOR v_def IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f
    LOOP
      v_new := regexp_replace(v_def, E'BEGIN PERFORM public\\.assert_financial_ops_area\\(''[a-z_]+''\\);', 'BEGIN', 'i');
      IF v_new <> v_def THEN EXECUTE v_new; END IF;
    END LOOP;
  END LOOP;
END
$guard$;

DROP FUNCTION IF EXISTS public.set_financial_ops_restriction(uuid, text[], text);
DROP FUNCTION IF EXISTS public.list_financial_ops_restrictions();
DROP FUNCTION IF EXISTS public.get_my_financial_ops_restrictions();
DROP FUNCTION IF EXISTS public.assert_financial_ops_area(text);
DROP FUNCTION IF EXISTS public.is_financial_ops_area_blocked(text);
-- The history table is kept; drop it only if it is not wanted:
-- DROP TABLE IF EXISTS public.financial_ops_restrictions;
