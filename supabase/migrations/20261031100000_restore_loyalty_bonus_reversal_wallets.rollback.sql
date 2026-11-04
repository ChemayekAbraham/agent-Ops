-- Undoes 20261031100000_restore_loyalty_bonus_reversal_wallets.sql: takes the restore credits back out (a counted debit per person, same category) with the platform leg.
-- Use only if the restore was a mistake.

DO $undo$
DECLARE
  r record;
  v_now timestamptz := now();
  v_ref text;
BEGIN
  FOR r IN
    SELECT g.user_id, g.amount, g.reference_id AS fix_ref,
           (SELECT p.user_id FROM public.general_ledger p WHERE p.reference_id = g.reference_id AND p.ledger_scope = 'platform' LIMIT 1) AS platform_id
      FROM public.general_ledger g
     WHERE g.reference_id LIKE 'PLB-FIX-%' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
  LOOP
    v_ref := 'PLB-FIXUNDO-' || substr(r.fix_ref, 9);
    IF EXISTS (SELECT 1 FROM public.general_ledger x WHERE x.idempotency_key = v_ref) THEN CONTINUE; END IF;
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.user_id, 'amount', r.amount, 'direction', 'cash_out', 'category', 'balance_correction',
          'ledger_scope', 'wallet', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Loyalty bonus reversal restore withdrawn again', 'currency', 'UGX', 'transaction_date', v_now),
        jsonb_build_object('user_id', r.platform_id, 'amount', r.amount, 'direction', 'cash_in', 'category', 'balance_correction',
          'ledger_scope', 'platform', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Loyalty bonus reversal restore withdrawn again from user ' || r.user_id, 'currency', 'UGX', 'transaction_date', v_now)
      ),
      v_ref,
      true
    );
  END LOOP;
END
$undo$;
