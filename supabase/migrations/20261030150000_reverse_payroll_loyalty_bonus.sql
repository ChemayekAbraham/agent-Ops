-- Reverse the payroll loyalty bonus (0.5% a day) that is still sitting in wallets. MONEY-MOVING: apply by hand, after the dry run.
--
-- What it takes back: for each person, the LESSER of
--   (a) the loyalty bonus they were credited and have not had reversed yet (ledger rows "Payroll loyalty bonus 0.5%/day ...", category
--       system_balance_correction, wallet scope), and
--   (b) what they can withdraw right now (v_user_wallet_strict.withdrawable), rounded down to whole shillings.
-- So a wallet never goes negative, nothing is taken for a bonus that was never credited, and no other balance is touched beyond the bonus amount:
-- the commission, float, advance and held balances are not read from, and money they already withdrew or spent is left alone and shown as "still owed".
--
-- Each reversal is two ledger legs that mirror the original credit (wallet cash_out system_balance_correction; platform cash_in interest_expense),
-- one transaction per person with an idempotency key, and one row in payroll_loyalty_bonus_reversals. Running it again takes back only what is
-- still unreversed AND still held, never the same bonus twice.
-- It does NOT change payroll_growth_balances, and it does NOT touch the daily switch (use CTO > Platform Controls for that).
-- Roll back with 20261030150000_reverse_payroll_loyalty_bonus.rollback.sql (posts the opposite legs, so it should be the exception, not the plan).

CREATE TABLE IF NOT EXISTS public.payroll_loyalty_bonus_reversals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  credited     numeric NOT NULL,            -- total bonus credited to the person when this ran
  reversed     numeric NOT NULL CHECK (reversed > 0),
  still_owed   numeric NOT NULL,            -- bonus credited, not reversed, and no longer in the wallet after this run
  ledger_group uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.payroll_loyalty_bonus_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_loyalty_bonus_reversals FROM PUBLIC, anon, authenticated;

DO $rev$
DECLARE
  r record;
  v_platform uuid;
  v_amt numeric;
  v_group uuid;
  v_now timestamptz := now();
  v_ref text;
  v_people int := 0;
  v_total numeric := 0;
BEGIN
  -- The platform account that carried the other leg of the original credits.
  SELECT g.user_id INTO v_platform
    FROM public.general_ledger g
   WHERE g.category = 'interest_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE 'Payroll loyalty bonus%'
   GROUP BY g.user_id ORDER BY count(*) DESC LIMIT 1;
  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'Could not find the platform account that carried the loyalty bonus. Nothing was reversed.';
  END IF;

  FOR r IN
    SELECT c.user_id, c.credited, c.credited - coalesce(rv.done, 0) AS remaining, greatest(coalesce(s.withdrawable, 0), 0) AS held
      FROM (SELECT user_id, sum(amount) AS credited
              FROM public.general_ledger
             WHERE category = 'system_balance_correction' AND ledger_scope = 'wallet' AND direction = 'cash_in'
               AND description ILIKE 'Payroll loyalty bonus%'
             GROUP BY user_id) c
      LEFT JOIN (SELECT user_id, sum(reversed) AS done FROM public.payroll_loyalty_bonus_reversals GROUP BY user_id) rv ON rv.user_id = c.user_id
      LEFT JOIN public.v_user_wallet_strict s ON s.user_id = c.user_id
     WHERE c.credited - coalesce(rv.done, 0) > 0
       AND EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = c.user_id)   -- a deleted account has no wallet to take it from
     ORDER BY c.user_id
  LOOP
    v_amt := floor(least(r.remaining, r.held));
    IF v_amt <= 0 THEN CONTINUE; END IF;

    v_ref := 'PLB-REV-' || replace(r.user_id::text, '-', '') || '-' || to_char(v_now, 'YYYYMMDDHH24MISS');
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.user_id, 'amount', v_amt, 'direction', 'cash_out', 'category', 'system_balance_correction',
          'ledger_scope', 'wallet', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Payroll loyalty bonus 0.5%/day reversed (bonus switched off)', 'currency', 'UGX', 'transaction_date', v_now,
          'classification', 'admin_correction', 'solvency_bypass_reason', 'other_with_note'),
        jsonb_build_object('user_id', v_platform, 'amount', v_amt, 'direction', 'cash_in', 'category', 'interest_expense',
          'ledger_scope', 'platform', 'source_table', 'payroll_growth_balances', 'reference_id', v_ref,
          'description', 'Payroll loyalty bonus 0.5%/day reversed from user ' || r.user_id, 'currency', 'UGX', 'transaction_date', v_now)
      ),
      v_ref,
      true
    );

    INSERT INTO public.payroll_loyalty_bonus_reversals (user_id, credited, reversed, still_owed, ledger_group)
    VALUES (r.user_id, r.credited, v_amt, r.remaining - v_amt, v_group);

    v_people := v_people + 1;
    v_total := v_total + v_amt;
  END LOOP;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, new_values)
  VALUES ('payroll_loyalty_bonus_reversed', 'payroll_loyalty_bonus_reversals', 'batch-' || to_char(v_now, 'YYYYMMDDHH24MISS'),
          'Loyalty bonus still held in wallets was taken back; bonus already withdrawn or spent was left alone',
          jsonb_build_object('people', v_people, 'total_reversed', v_total));

  RAISE NOTICE 'Reversed % from % people.', v_total, v_people;
END
$rev$;
