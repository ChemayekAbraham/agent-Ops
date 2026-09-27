-- Agent Advance waterfall, Stage E path 7 of 7:
-- cfo_record_advance_payment -- WALLET_OFFSET BRANCH ONLY.
--
-- NOT YET APPLIED.
--
-- Only the `p_payment_method = 'wallet_offset'` branch changes. The external
-- cash/bank branch is reproduced byte for byte and stays dead:
-- `agent_advance_receipt_bank` and `agent_advance_repayment_external` are both
-- absent from ledger_category_allowlist() and have zero legs, so with
-- strict_mode = true that branch raises on its second leg and posts nothing.
-- Reviving it is a separate decision about external cash receipts and is not
-- in scope here.
--
-- In the wallet_offset branch the funding leg is hoisted into v_funding and
-- used by BOTH regimes, byte-identical to today: same category,
-- recipient_type, description, currency, transaction_date, for exactly v_paid.
-- No additional wallet movement is introduced -- the waterfall only changes
-- how the platform side is split.
--
-- Everything else is unchanged: the CFO/Manager authorisation gate, the
-- payment-method allowlist, the FOR UPDATE lock, the completed/cancelled
-- guards, v_paid = LEAST(p_amount, v_opening), the fee-ratio marker, the
-- null-group abort, the daybook INSERT, the advance UPDATE and the audit_logs
-- row including its `receiving_account` mapping.
--
-- Production body before this change: fc863de69dfc2c1b235eb345a1bdaa87
--   (180 non-comment body lines, full definition 2c1519fad77d7405feb02923288b51dc)

CREATE OR REPLACE FUNCTION public.cfo_record_advance_payment(p_advance_id uuid, p_amount numeric, p_payment_method text, p_reference text, p_notes text DEFAULT NULL::text)
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
  v_alloc          jsonb;
  v_funding        jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can record advance payments'
      USING ERRCODE = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A positive amount is required' USING ERRCODE = '22023';
  END IF;

  IF p_reference IS NULL OR length(trim(p_reference)) = 0 THEN
    RAISE EXCEPTION 'A payment reference is required' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IS NULL OR length(trim(p_payment_method)) = 0 THEN
    RAISE EXCEPTION 'A payment method is required' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method NOT IN ('wallet_offset', 'mobile_money', 'bank_transfer', 'cash') THEN
    RAISE EXCEPTION
      'Unsupported payment_method %. Supported: wallet_offset, mobile_money, bank_transfer, cash. The payment has NOT been recorded.', p_payment_method
      USING ERRCODE = '0A000';
  END IF;

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

  v_idem := 'cfo_adv_pay_' || p_advance_id::text || '_'
            || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

  v_description := 'CFO-recorded advance payment - ref ' || trim(p_reference)
                   || ' - ' || p_payment_method
                   || COALESCE(' - ' || nullif(trim(p_notes), ''), '');

  IF p_payment_method = 'wallet_offset' THEN
    v_funding := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'wallet',
        'direction', 'cash_out', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ));

    v_alloc := public.agent_advance_allocation_entries(
                 p_advance_id, v_adv.agent_id, v_paid, v_today::timestamptz, false);

    IF v_alloc IS NULL THEN
      v_entries := v_funding || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_in', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ));
    ELSE
      v_entries := v_funding || v_alloc;
    END IF;
  ELSE
    v_recv_category := CASE
      WHEN p_payment_method = 'cash' THEN 'cash_receipt_in_transit'
      ELSE 'agent_advance_receipt_bank'
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

  SELECT public.create_ledger_transaction(
    entries         => v_entries,
    idempotency_key => v_idem
  ) INTO v_group_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'Ledger posting returned no transaction group; aborting'
      USING ERRCODE = 'P0001';
  END IF;

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
