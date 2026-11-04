-- Puts the reversed loyalty bonus back (posts the opposite legs for every row in payroll_loyalty_bonus_reversals), then marks the rows undone.
-- Use only if the reversal was a mistake. It credits each person the amount that was taken, as at the time of the reversal.

DO $undo$
DECLARE
  r record;
  v_platform uuid;
  v_now timestamptz := now();
  v_ref text;
BEGIN
  SELECT g.user_id INTO v_platform
    FROM public.general_ledger g
   WHERE g.category = 'interest_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE 'Payroll loyalty bonus%'
   GROUP BY g.user_id ORDER BY count(*) DESC LIMIT 1;
  IF v_platform IS NULL THEN RAISE EXCEPTION 'Platform account not found. Nothing was undone.'; END IF;

  FOR r IN SELECT * FROM public.payroll_loyalty_bonus_reversals ORDER BY created_at LOOP
    v_ref := 'PLB-UNDO-' || r.id::text;
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.user_id, 'amount', r.reversed, 'direction', 'cash_in', 'category', 'system_balance_correction',
          'ledger_scope', 'wallet', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Payroll loyalty bonus 0.5%/day restored (reversal undone)', 'currency', 'UGX', 'transaction_date', v_now),
        jsonb_build_object('user_id', v_platform, 'amount', r.reversed, 'direction', 'cash_out', 'category', 'interest_expense',
          'ledger_scope', 'platform', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Payroll loyalty bonus 0.5%/day restored to user ' || r.user_id, 'currency', 'UGX', 'transaction_date', v_now)
      ),
      v_ref,
      true
    );
  END LOOP;

  DELETE FROM public.payroll_loyalty_bonus_reversals;
END
$undo$;
