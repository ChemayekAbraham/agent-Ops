-- Phase 0 — control fix for CFO-recorded agent advance repayments,
-- plus the one Phase 1 mapping needed to make external receipts postable.
--
-- WHY THIS EXISTS
-- ---------------
-- `cfo-record-advance-payment` wrote the subledger and the advance row through
-- separate PostgREST calls, then posted the ledger with:
--
--     if (rpcErr) console.error('[cfo-record-advance-payment] RPC error:', rpcErr);
--
-- The error was logged and swallowed. The balance was already reduced and the
-- audit row was written regardless, so a failed posting still looked like a
-- completed payment.
--
-- Thirteen entries failed this way between 2026-08-20 and 2026-09-23, totalling
-- UGX 6,785,998.18 across six advances. Every one failed for the same reason:
-- the function posted a WALLET cash_out leg for every payment method, and
-- `create_ledger_transaction` raises 'Insufficient ledger balance' when the
-- agent's withdrawable balance cannot cover it. Those agents held between
-- UGX 320 and UGX 15,070 against debits of up to UGX 2,000,000.
--
-- Note what that means: had those postings SUCCEEDED, each agent would have
-- been charged twice — once in mobile money, once out of their wallet. The
-- wallet leg was never the right treatment for an external receipt.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Adds TWO ledger_account_map rows, both dedicated to this flow:
--      platform/agent_advance_repayment_external -> A10, debit_when 'cash_in'
--      platform/agent_advance_receipt_bank       -> A1,  debit_when 'cash_in'
--
--    The polarity is forced by create_ledger_transaction, which requires
--    total cash_in = total cash_out: the A1/A5 debit leg must be cash_in
--    (every usable debit category there has debit_when = 'cash_in'), which
--    leaves the A10 credit leg as cash_out, which in turn requires
--    debit_when = 'cash_in' to resolve as a credit.
--
--    A dedicated A1 category is required rather than an existing one.
--    `verified_bank_cash_recognised` was considered and rejected: it is
--    written only by recognise_verified_bank_cash, always pairs with
--    A8 `agent_float_cycle_settled_to_bank`, always writes
--    bank_cash_recognition_log, and means "float-backed cash verified as
--    banked". Reusing it would assert that mobile money sitting in a MoMo
--    float had been banked, would fabricate a float-cycle settlement, and
--    would break the one-to-one between A1 legs and cash_deposit_verifications
--    that the bank reconciliation relies on. No other existing A1 category
--    fits either: treasury_bank_deposit is the banking half of an A5->A1
--    transfer, cash_at_bank_reclass is a location move, wallet_* are wallet
--    flows, rent_disbursement and agent_landlord_payout are outflows, and
--    partner_capital_cash_received is capital.
--
-- 2. Creates public.cfo_record_advance_payment — one SECURITY DEFINER
--    transaction covering the subledger write, the advance update, the ledger
--    posting and the audit row. Any RAISE aborts all four.
--
-- METHOD -> LEGS
-- --------------
--   wallet_offset  wallet   cash_out agent_repayment                   -> DR L1
--                  platform cash_in  agent_repayment                   -> CR A10 (resolver)
--   mobile_money   platform cash_in  agent_advance_receipt_bank        -> DR A1
--                  platform cash_out agent_advance_repayment_external  -> CR A10
--   bank_transfer  platform cash_in  agent_advance_receipt_bank        -> DR A1
--                  platform cash_out agent_advance_repayment_external  -> CR A10
--   cash           platform cash_in  cash_receipt_in_transit           -> DR A5
--                  platform cash_out agent_advance_repayment_external  -> CR A10
--   other          rejected; no invented treatment
--
--   cash_receipt_in_transit is reused deliberately: physical cash received and
--   in transit to bank is exactly what it means, and both of its consumers are
--   unaffected — get_money_at_bank_reconciliation filters on source_table IN
--   ('cfo_direct_credit','financial_ops_manual_entry'), and
--   assert_money_path_intact only checks the custody leg is present.
--
-- External methods post PLATFORM-ONLY legs. The solvency check in
-- create_ledger_transaction fires only for wallet scope + user_id +
-- withdrawable bucket, so these cannot touch a wallet balance and cannot be
-- blocked by an empty one.
--
-- OUT OF SCOPE — deliberately unchanged
-- -------------------------------------
-- No write-off, fee, penalty or cancellation accounting. No A11 retirement.
-- No change to sofp_ledger_legs, no resolver override removed, no historical
-- row touched, no wallet/tenant-repayment behaviour altered, no A10/A11
-- balance moved until a real repayment is recorded.

---------------------------------------------------------------------------
-- 1. The two new mappings. Both are reserved for the agent advance
--    repayment flow and must not be reused elsewhere.
---------------------------------------------------------------------------
INSERT INTO public.ledger_account_map
  (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  ('platform', 'agent_advance_repayment_external', NULL, 'A10', 'cash_in',
   'Credit side of an agent advance repayment received OUTSIDE the wallet '
   '(mobile money, bank transfer, cash). Pairs with a cash_in debit leg to '
   'A1 (agent_advance_receipt_bank) or A5 (cash_receipt_in_transit). '
   'debit_when = cash_in so the cash_out leg resolves as a CREDIT to A10, '
   'which is what keeps total cash_in = total cash_out inside '
   'create_ledger_transaction. Reserved for cfo_record_advance_payment. '
   'Added Phase 0 (2026-09-25).'),
  ('platform', 'agent_advance_receipt_bank', NULL, 'A1', 'cash_in',
   'Debit side of an agent advance repayment received by mobile money or '
   'bank transfer. DELIBERATELY SEPARATE from verified_bank_cash_recognised, '
   'which is reserved for float-backed cash verified as banked, pairs with A8 '
   'agent_float_cycle_settled_to_bank and writes bank_cash_recognition_log. '
   'Also separate from treasury_bank_deposit and every wallet/deposit '
   'category. Pairs with agent_advance_repayment_external (CR A10). '
   'Reserved for cfo_record_advance_payment. Added Phase 0 (2026-09-25).')
ON CONFLICT DO NOTHING;

---------------------------------------------------------------------------
-- 2. The atomic RPC.
---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cfo_record_advance_payment(
  p_advance_id     uuid,
  p_amount         numeric,
  p_payment_method text,
  p_reference      text,
  p_notes          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_adv            RECORD;
  v_today          date;
  v_opening        numeric;
  v_paid           numeric;
  v_closing        numeric;
  v_new_status     text;
  v_total_payable  numeric;
  v_total_deducted numeric;
  v_fee_ratio      numeric;
  v_new_fee        numeric;
  v_fee_status     text;
  v_group_id       uuid;
  v_idem           text;
  v_description    text;
  v_entries        jsonb;
  v_recv_category  text;
BEGIN
  ---------------------------------------------------------------------------
  -- Guards. Every one raises, which aborts the whole transaction.
  ---------------------------------------------------------------------------
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- The previous implementation had NO role gate: any authenticated caller
  -- could reduce an advance balance. Matches cancel_agent_advance.
  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can record advance payments'
      USING ERRCODE = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A positive amount is required' USING ERRCODE = '22023';
  END IF;

  -- All 13 defective entries carried reference = NULL, which is why not one of
  -- them can be tied to a mobile-money or bank record today.
  IF p_reference IS NULL OR length(trim(p_reference)) = 0 THEN
    RAISE EXCEPTION 'A payment reference is required' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IS NULL OR length(trim(p_payment_method)) = 0 THEN
    RAISE EXCEPTION 'A payment method is required' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method NOT IN ('wallet_offset', 'mobile_money', 'bank_transfer', 'cash') THEN
    RAISE EXCEPTION
      'Unsupported payment_method %. Supported: wallet_offset, mobile_money, '
      'bank_transfer, cash. The payment has NOT been recorded.', p_payment_method
      USING ERRCODE = '0A000';
  END IF;

  ---------------------------------------------------------------------------
  -- Lock and validate the advance.
  ---------------------------------------------------------------------------
  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_adv.status = 'completed' THEN
    RAISE EXCEPTION 'Advance already completed' USING ERRCODE = '22023';
  END IF;
  IF v_adv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Advance already cancelled' USING ERRCODE = '22023';
  END IF;

  v_today   := (now() AT TIME ZONE 'UTC')::date;
  v_opening := COALESCE(v_adv.outstanding_balance, 0);
  v_paid    := LEAST(p_amount, v_opening);
  v_closing := GREATEST(0, v_opening - v_paid);

  IF v_paid <= 0 THEN
    RAISE EXCEPTION 'Nothing to collect: outstanding balance is %', v_opening
      USING ERRCODE = '22023';
  END IF;

  v_new_status := CASE
    WHEN v_closing <= 0 THEN 'completed'
    WHEN v_adv.expires_at < now() THEN 'overdue'
    ELSE 'active'
  END;

  ---------------------------------------------------------------------------
  -- Access-fee pro-rata.
  --
  -- The old expression was LEAST(1, deducted / payable) with no lower bound.
  -- outstanding_balance capitalises penalty interest but v_total_payable does
  -- not, so once penalties push outstanding above principal + fee the ratio
  -- went negative and wrote a negative access_fee_collected. That is how 282
  -- advances came to hold -1,085,824 in total, with "uncollected" exceeding
  -- the fee ever charged. GREATEST(0, ...) floors it.
  ---------------------------------------------------------------------------
  v_total_payable  := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
  v_total_deducted := v_total_payable - v_closing;
  v_fee_ratio      := CASE
    WHEN v_total_payable > 0
      THEN GREATEST(0, LEAST(1, v_total_deducted / v_total_payable))
    ELSE 0
  END;
  v_new_fee    := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
  v_fee_status := CASE
    WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
    WHEN v_new_fee > 0 THEN 'partial'
    ELSE 'unpaid'
  END;

  ---------------------------------------------------------------------------
  -- Build the legs for the selected method.
  ---------------------------------------------------------------------------
  v_idem := 'cfo_adv_pay_' || p_advance_id::text || '_'
            || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

  v_description := 'CFO-recorded advance payment · ref ' || trim(p_reference)
                   || ' · ' || p_payment_method
                   || COALESCE(' · ' || nullif(trim(p_notes), ''), '');

  IF p_payment_method = 'wallet_offset' THEN
    -- Unchanged from the existing working path: the agent's own wallet
    -- balance settles the advance. This one SHOULD hit the solvency check —
    -- it is a real wallet debit and must fail if the balance is not there.
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'wallet',
        'direction', 'cash_out', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ),
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_in', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      )
    );
  ELSE
    -- External receipt. PLATFORM-ONLY: the money arrived outside the wallet,
    -- so no wallet balance may move. Cash lands in A5 (in transit to bank);
    -- mobile money and bank transfer land in A1.
    v_recv_category := CASE
      WHEN p_payment_method = 'cash' THEN 'cash_receipt_in_transit'  -- -> A5
      ELSE 'agent_advance_receipt_bank'                              -- -> A1
    END;

    v_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_in', 'amount', v_paid,
        'category', v_recv_category, 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ),
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_out', 'amount', v_paid,
        'category', 'agent_advance_repayment_external',
        'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      )
    );
  END IF;

  ---------------------------------------------------------------------------
  -- Ledger FIRST. If this raises, nothing below runs and everything above
  -- rolls back with it.
  ---------------------------------------------------------------------------
  SELECT public.create_ledger_transaction(
    entries         => v_entries,
    idempotency_key => v_idem
  ) INTO v_group_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'Ledger posting returned no transaction group; aborting'
      USING ERRCODE = 'P0001';
  END IF;

  ---------------------------------------------------------------------------
  -- Only now touch the operational records.
  ---------------------------------------------------------------------------
  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, v_today, v_opening, 0, v_paid, v_closing,
     CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

  UPDATE public.agent_advances SET
    outstanding_balance  = v_closing,
    status               = v_new_status,
    access_fee_collected = v_new_fee,
    access_fee_status    = v_fee_status,
    updated_at           = now()
  WHERE id = p_advance_id;

  INSERT INTO public.audit_logs
    (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    'cfo_advance_payment_recorded',
    'agent_advances',
    p_advance_id,
    left(COALESCE(nullif(trim(p_notes), ''), 'manual payment ' || trim(p_reference)), 200),
    jsonb_build_object(
      'amount',               v_paid,
      'payment_method',       p_payment_method,
      'reference',            trim(p_reference),
      'opening_balance',      v_opening,
      'closing_balance',      v_closing,
      'new_status',           v_new_status,
      'transaction_group_id', v_group_id,
      'receiving_account',    CASE
                                WHEN p_payment_method = 'wallet_offset' THEN 'L1'
                                WHEN p_payment_method = 'cash' THEN 'A5'
                                ELSE 'A1' END,
      'posted_atomically',    true
    )
  );

  RETURN jsonb_build_object(
    'success',              true,
    'amount',               v_paid,
    'payment_method',       p_payment_method,
    'opening_balance',      v_opening,
    'closing_balance',      v_closing,
    'new_status',           v_new_status,
    'transaction_group_id', v_group_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cfo_record_advance_payment(uuid, numeric, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cfo_record_advance_payment(uuid, numeric, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.cfo_record_advance_payment(uuid, numeric, text, text, text) IS
  'Phase 0 atomic replacement for the cfo-record-advance-payment edge function body. '
  'Posts the ledger before touching agent_advances or agent_advance_ledger, so a failed '
  'posting cannot leave a subledger-only reduction. External receipts post platform-only '
  'legs (A1/A5 debit, A10 credit) and never move a wallet balance.';
