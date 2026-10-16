-- Reallocate UGX 240,696.80 of wallet-backed deductions collected on Sharifu Kalule's
-- cancelled advance cef95679 (write-off 2026-10-16) to her active advance b94abec1.
-- CFO decision 2026-10-16. Only deductions with a wallet_entry_id are counted; the
-- 59,082 of unlinked small deductions and the 506,936 reinstated fake manual payments
-- are excluded.
--
-- Statement-only reallocation: the cash was already collected on cef95679, so there is
-- NO new wallet debit and NO new general_ledger posting (cfo_record_advance_payment
-- would double-count). Mirrors its statement/fee/status maths. The statement row is
-- inserted before the balance update so tg_advance_balance_must_be_on_statement sees
-- no unexplained difference. Idempotent via the audit row.
DO $$
DECLARE
  v_to    uuid    := 'b94abec1-37b7-4eb0-8af5-200373aa140b';
  v_from  uuid    := 'cef95679-bd3b-4b4a-88a0-bae32e39a1c5';
  v_by    uuid    := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_amt   numeric := 240696.80;
  v_adv   record;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_opening numeric; v_paid numeric; v_closing numeric;
  v_payable numeric; v_ratio numeric; v_new_fee numeric; v_fee_status text; v_status text;
  v_note  text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_logs
             WHERE action_type = 'advance_collections_reallocated'
               AND record_id = v_to::text) THEN
    RETURN;
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances
  WHERE id = v_to AND status IN ('active', 'overdue') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target advance % not found or not open', v_to;
  END IF;

  -- Guard: the wallet-backed collections on the cancelled advance must still total v_amt
  -- (excluding anything after the cancel timestamp).
  IF (SELECT COALESCE(sum(amount_deducted), 0) FROM public.agent_advance_ledger
      WHERE advance_id = v_from AND wallet_entry_id IS NOT NULL
        AND created_at < '2026-10-16 08:30:02.738035+00') <> v_amt THEN
    RAISE EXCEPTION 'Wallet-backed collections on % no longer total %; aborting', v_from, v_amt;
  END IF;

  v_opening := v_adv.outstanding_balance;
  v_paid    := LEAST(v_amt, v_opening);
  v_closing := GREATEST(0, v_opening - v_paid);
  v_status  := CASE WHEN v_closing <= 0 THEN 'completed'
                    WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;
  v_payable := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
  v_ratio   := CASE WHEN v_payable > 0
                    THEN GREATEST(0, LEAST(1, (v_payable - v_closing) / v_payable)) ELSE 0 END;
  v_new_fee := round(COALESCE(v_adv.access_fee, 0) * v_ratio);
  v_fee_status := CASE WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
                       WHEN v_new_fee > 0 THEN 'partial' ELSE 'unpaid' END;
  v_note := 'Reallocated from cancelled advance ' || v_from::text
            || ': UGX 240,696.80 wallet-backed collections, CFO-approved 2026-10-16 (no new wallet/GL movement)';

  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status, recovery_source, note)
  VALUES (v_to, v_today, v_opening, 0, v_paid, v_closing,
          CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END,
          'reallocation', left(v_note, 500));

  UPDATE public.agent_advances SET
    outstanding_balance  = v_closing,
    status               = v_status,
    access_fee_collected = v_new_fee,
    access_fee_status    = v_fee_status,
    updated_at           = now()
  WHERE id = v_to;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_by, 'advance_collections_reallocated', 'agent_advances', v_to,
          left(v_note, 200),
          jsonb_build_object('from_advance', v_from, 'amount', v_paid,
                             'opening_balance', v_opening, 'closing_balance', v_closing,
                             'new_status', v_status, 'wallet_movement', false,
                             'general_ledger_posting', false));
END $$;
