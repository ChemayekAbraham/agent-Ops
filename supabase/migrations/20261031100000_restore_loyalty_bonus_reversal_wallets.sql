-- Put back the money that the loyalty-bonus reversal took from 42 wallets and that its rollback did not return. MONEY-MOVING: apply by hand.
--
-- What went wrong: the reversal (20261030150000) debited each wallet through category system_balance_correction, which the wallet balance view counts.
-- The rollback credited it back through the SAME category, and the ledger classifies a system_balance_correction credit as admin_correction, which the
-- view does NOT count (the ledger rows exist, the wallets did not move). The ledger is immutable, so those rows cannot be corrected.
--
-- What this does: for every person who has a PLB-UNDO wallet credit, post ONE new credit of the same amount in category balance_correction
-- (classification production, which the wallet view counts and routes to the withdrawable balance), with the matching platform leg, in one
-- transaction per person. After it, each wallet is back to what it was before the reversal, less anything the person withdrew in between.
-- Each person is restored once: an idempotency key (PLB-FIX-<user>) makes a second run do nothing.
-- The platform legs of the rollback were already posted, so the platform side now carries the refund twice; that is a CFO ledger correction to
-- net off, and this file does not touch it.
-- It does not change payroll_growth_balances and does not touch the daily switch.

DO $fix$
DECLARE
  r record;
  v_platform uuid;
  v_group uuid;
  v_now timestamptz := now();
  v_ref text;
  v_people int := 0;
  v_total numeric := 0;
BEGIN
  SELECT g.user_id INTO v_platform
    FROM public.general_ledger g
   WHERE g.category = 'interest_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE 'Payroll loyalty bonus%'
   GROUP BY g.user_id ORDER BY count(*) DESC LIMIT 1;
  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'Could not find the platform account. Nothing was restored.';
  END IF;

  FOR r IN
    SELECT u.user_id, sum(u.amount) AS amount
      FROM public.general_ledger u
     WHERE u.reference_id LIKE 'PLB-UNDO-%' AND u.ledger_scope = 'wallet' AND u.direction = 'cash_in'
       AND EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = u.user_id)
     GROUP BY u.user_id
     ORDER BY u.user_id
  LOOP
    v_ref := 'PLB-FIX-' || replace(r.user_id::text, '-', '');
    IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = v_ref) THEN CONTINUE; END IF;

    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.user_id, 'amount', r.amount, 'direction', 'cash_in', 'category', 'balance_correction',
          'ledger_scope', 'wallet', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Loyalty bonus reversal undone: money taken on 30 Oct returned to your wallet', 'currency', 'UGX', 'transaction_date', v_now),
        jsonb_build_object('user_id', v_platform, 'amount', r.amount, 'direction', 'cash_out', 'category', 'balance_correction',
          'ledger_scope', 'platform', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Loyalty bonus reversal undone: returned to user ' || r.user_id, 'currency', 'UGX', 'transaction_date', v_now)
      ),
      v_ref,
      true
    );
    v_people := v_people + 1;
    v_total := v_total + r.amount;
  END LOOP;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, new_values)
  VALUES ('payroll_loyalty_bonus_reversal_wallets_restored', 'general_ledger', 'batch-' || to_char(v_now, 'YYYYMMDDHH24MISS'),
          'Wallets restored after the loyalty bonus reversal debit counted but its rollback credit did not',
          jsonb_build_object('people', v_people, 'total_restored', v_total));

  RAISE NOTICE 'Restored % to % people.', v_total, v_people;
END
$fix$;
