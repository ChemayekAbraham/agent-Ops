-- doc 207: cfo_cancel_bike_lease — cancel an agent-wallet-funded Spiro bike lease after
-- disbursement and claw the money back, atomically.
--
-- Why: a bike lease disbursed under the old agent-wallet method credits the agent's wallet
-- as `agent_advance_credit`, which `get_user_available_balance` locks while
-- `advance_withdrawals_paused` is on. CFO Direct Debit therefore saw "available 1,000" on a
-- 145,000 wallet and offered only Forced Reversal (a fake recoverable debt). There was also
-- no RPC to cancel a lease once disbursed (`reject_bike_lease` stops at coo_approved).
--
-- 1) enforce_no_negative_wallet_ledger: the existing `advance_reversal:%` exemption (measure
--    against the reversal-scoped balance) is extended to the bike-lease cancellation leg, but
--    ONLY for category agent_advance_credit, reference 'bike-lease-cancel-<sale_id>', and an
--    approved lease owned by the wallet owner. Everything else is the live body unchanged.
-- 2) cfo_cancel_bike_lease(p_sale_id, p_reason): one create_ledger_transaction group that
--    (a) refunds repayments already taken for the lease and (b) reverses the disbursement
--    (wallet cash_out + platform equipment_expense credited back), then closes the sale
--    (order_status 'rejected'), cancels the recovery plan and zeroes what is owed.
--    No cfo_debit_obligations row, no recoverable debt. Refuses if the agent has already
--    spent any of the disbursement; it never creates a receivable.
--
-- Mapped double-entry of the single group (existing categories, no mapping/allowlist change):
--   wallet cash_in  agent_repayment            CR L1   refund of repayments
--   platform cash_out bike_recovery_repayment  DR A13  re-opens what the repayment reduced
--   wallet cash_out agent_advance_credit       DR L1   claw back the disbursement
--   platform cash_in equipment_expense         CR X1   expense reversed
--   => DR = CR = repaid + disbursed

CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric := 0;
  v_float numeric := 0;
  v_current_hold numeric := 0;
  v_effective_bucket text := 'withdrawable';
  v_is_admin_bypass boolean := false;
  v_is_writeoff_bypass boolean := false;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.direction NOT IN ('cash_out', 'debit') THEN
    RETURN NEW;
  END IF;

  v_is_admin_bypass := COALESCE(NEW.classification, '') = 'admin_correction';
  v_is_writeoff_bypass := COALESCE(NEW.category, '') = 'platform_loss_writeoff';

  IF v_is_admin_bypass OR v_is_writeoff_bypass THEN
    IF NEW.solvency_bypass_reason IS NULL THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_REASON_REQUIRED: cash_out leg classified % / category % must include a solvency_bypass_reason code',
        COALESCE(NEW.classification, '(null)'), COALESCE(NEW.category, '(null)')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.solvency_bypass_reason = 'other_with_note'
       AND length(COALESCE(NEW.description, '')) < 30 THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_NOTE_REQUIRED: reason code other_with_note requires a description of at least 30 characters'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN
    RETURN NEW;
  END IF;

  v_effective_bucket := COALESCE(
    NULLIF(NEW.wallet_bucket, ''),
    CASE
      WHEN NEW.recipient_type = 'operational_wallet' THEN 'float'
      WHEN NEW.recipient_type = 'user' THEN 'withdrawable'
      ELSE NULL
    END,
    (
      SELECT r.bucket
      FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction) r
      LIMIT 1
    ),
    'withdrawable'
  );

  IF v_effective_bucket = 'float'
     OR COALESCE(NEW.recipient_type, '') = 'operational_wallet' THEN
    SELECT float_balance INTO v_float
    FROM public.wallet_balances_projection
    WHERE user_id = NEW.user_id;

    IF v_float IS NULL THEN
      SELECT COALESCE(float_balance, 0) INTO v_float
      FROM public.wallet_strict_for_user(NEW.user_id);
    END IF;

    IF COALESCE(v_float, 0) < NEW.amount THEN
      RAISE EXCEPTION 'NEGATIVE_FLOAT_BLOCKED: user % cannot debit % from float (ledger-backed float balance is %)',
        NEW.user_id, NEW.amount, COALESCE(v_float, 0)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_table = 'withdrawal_requests' AND NEW.source_id IS NOT NULL THEN
    SELECT COALESCE(wr.amount, 0)
      INTO v_current_hold
    FROM public.withdrawal_requests wr
    WHERE wr.id = NEW.source_id
      AND wr.status IN ('pending', 'requested', 'manager_approved', 'processing', 'approved')
      AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
      AND (
        CASE
          WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
          ELSE wr.user_id
        END
      ) = NEW.user_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction IN ('cash_out', 'debit')
      )
    LIMIT 1;
  END IF;

  -- Portfolio funding debits: a pending funder reservation for THIS portfolio is
  -- what the debit is settling, so it must not block its own settlement. Every
  -- other pending commitment stays held. Mirrors the withdrawal allowance above.
  IF NEW.source_table = 'investor_portfolios' AND NEW.source_id IS NOT NULL THEN
    SELECT COALESCE(fpp.amount, 0)
      INTO v_current_hold
    FROM public.funder_pending_portfolios fpp
    WHERE fpp.portfolio_id = NEW.source_id
      AND fpp.funder_id = NEW.user_id
      AND fpp.status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'investor_portfolios'
          AND g.source_id = fpp.portfolio_id
          AND g.ledger_scope = 'wallet'
          AND g.direction IN ('cash_out', 'debit')
      )
    LIMIT 1;
  END IF;

  -- Advance-reversal clawbacks recover the very funds that the
  -- `advance_withdrawals_paused` treasury control locks, so they must be
  -- measured against the reversal-scoped balance (locked advance funds
  -- included). Everything else keeps the strict withdrawable gate.
  -- Bike-lease cancellations recover the same locked agent_advance_credit. They are
  -- recognised by shape (create_ledger_transaction does not persist sub_category): the leg
  -- must reference 'bike-lease-cancel-<sale_id>' for that same sale, and that sale must be an
  -- approved lease owned by this wallet owner, so a made-up reference cannot lift the lock.
  IF COALESCE(NEW.sub_category, '') LIKE 'advance_reversal:%'
     OR (NEW.category = 'agent_advance_credit'
         AND NEW.source_table = 'merchandise_sales'
         AND NEW.source_id IS NOT NULL
         AND NEW.reference_id = 'bike-lease-cancel-' || NEW.source_id::text
         AND EXISTS (SELECT 1 FROM public.agent_bike_leases bl
                     WHERE bl.sale_id = NEW.source_id
                       AND bl.agent_id = NEW.user_id
                       AND bl.status = 'approved'))
     OR (NEW.category = 'agent_repayment'
         AND NEW.source_table = 'merchandise_recovery_plans'
         AND EXISTS (SELECT 1 FROM public.merchandise_recovery_plans mp
                     WHERE mp.id = NEW.source_id AND mp.phone_collection_enabled
                       AND NOT COALESCE(mp.is_bike_lease, false))) THEN
    v_available := COALESCE(public.get_user_advance_reversal_available(NEW.user_id), 0)
                   + COALESCE(v_current_hold, 0);
  ELSE
    v_available := COALESCE(public.get_user_available_balance(NEW.user_id), 0) + COALESCE(v_current_hold, 0);
  END IF;

  IF v_available < NEW.amount THEN
    RAISE EXCEPTION 'LEDGER_BACKING_REQUIRED: user % cannot debit % from withdrawable funds (ledger-backed available is %)',
      NEW.user_id, NEW.amount, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.cfo_cancel_bike_lease(p_sale_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_plan public.merchandise_recovery_plans;
  v_agent uuid;
  v_name text;
  v_ref text := 'bike-lease-cancel-' || p_sale_id::text;
  v_disb_ref text := 'bike-lease-disbursement-' || p_sale_id::text;
  v_disbursed numeric;
  v_refund numeric;
  v_avail numeric;
  v_group uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_entries jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to cancel Spiro bike leases';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Provide a cancellation reason of at least 10 characters';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Bike lease not found';
  END IF;
  IF lower(COALESCE(v_sale.item_name, '')) NOT LIKE '%spiro%' THEN
    RAISE EXCEPTION 'This is not a Spiro bike lease';
  END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
    RAISE EXCEPTION 'This bike lease was already cancelled';
  END IF;
  IF COALESCE(v_sale.order_status, '') <> 'approved' OR v_sale.cfo_disbursed_at IS NULL THEN
    RAISE EXCEPTION 'Only a disbursed, active lease can be cancelled (currently %). Use reject_bike_lease before disbursement.',
      COALESCE(v_sale.order_status, 'submitted');
  END IF;

  v_agent := v_sale.customer_id;
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'Lease has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_agent;

  -- Only the old agent-wallet method can be clawed back from the agent. A supplier-paid
  -- lease sent the money to the supplier; it needs a supplier refund, not a wallet debit.
  SELECT amount INTO v_disbursed
  FROM public.general_ledger
  WHERE reference_id = v_disb_ref AND ledger_scope = 'wallet' AND direction = 'cash_in'
    AND category = 'agent_advance_credit' AND user_id = v_agent;
  IF v_disbursed IS NULL OR v_disbursed <= 0 THEN
    RAISE EXCEPTION 'No agent-wallet disbursement found for this lease (supplier-paid leases cannot be clawed back from the agent)';
  END IF;

  SELECT * INTO v_plan FROM public.merchandise_recovery_plans
  WHERE sale_id = p_sale_id AND COALESCE(is_bike_lease, false) AND status = 'active'
  FOR UPDATE;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'No active recovery plan for this lease';
  END IF;

  -- What the agent has already repaid on this lease must be refunded. It has to agree with
  -- the plan's own counter, otherwise a human needs to look before any money moves.
  SELECT COALESCE(SUM(amount), 0) INTO v_refund
  FROM public.general_ledger
  WHERE ledger_scope = 'wallet' AND direction = 'cash_out' AND category = 'agent_repayment'
    AND source_table = 'merchandise_recovery_plans' AND source_id = v_plan.id AND user_id = v_agent;
  IF v_refund <> COALESCE(v_plan.amount_recovered, 0) THEN
    RAISE EXCEPTION 'Repayments in the ledger (%) do not match the plan''s recovered amount (%). Reconcile before cancelling.',
      v_refund, COALESCE(v_plan.amount_recovered, 0);
  END IF;

  -- The refund lands first in the same group, so the wallet must cover the clawback after it.
  -- If the agent already spent part of the disbursement we stop: no debt is ever created here.
  v_avail := COALESCE(public.get_user_advance_reversal_available(v_agent), 0) + v_refund;
  IF v_avail < v_disbursed THEN
    RAISE EXCEPTION 'Agent wallet holds % after refund but the disbursement to claw back is %. Part of it was already spent; resolve that first (no debt is created by this tool).',
      v_avail, v_disbursed;
  END IF;

  v_entries := '[]'::jsonb;
  IF v_refund > 0 THEN
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent, 'amount', v_refund, 'direction', 'cash_in',
        'category', 'agent_repayment', 'ledger_scope', 'wallet', 'recipient_type', 'user',
        'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_sales', 'source_id', p_sale_id,
        'reference_id', v_ref, 'currency', 'UGX', 'transaction_date', now(),
        'description', 'Bike lease cancelled: repayments refunded to ' || COALESCE(v_name, 'agent')
      ),
      jsonb_build_object(
        'user_id', v_agent, 'amount', v_refund, 'direction', 'cash_out',
        'category', 'bike_recovery_repayment', 'ledger_scope', 'platform',
        'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
        'reference_id', v_ref, 'currency', 'UGX', 'transaction_date', now(),
        'description', 'Bike lease cancelled: repayments refunded to ' || COALESCE(v_name, 'agent')
      )
    );
  END IF;
  v_entries := v_entries || jsonb_build_array(
    jsonb_build_object(
      'user_id', v_agent, 'amount', v_disbursed, 'direction', 'cash_out',
      'category', 'agent_advance_credit', 'ledger_scope', 'wallet', 'recipient_type', 'user',
      'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_sales', 'source_id', p_sale_id,
      'reference_id', v_ref, 'currency', 'UGX', 'transaction_date', now(),
      'description', 'Bike lease cancelled: disbursement clawed back from ' || COALESCE(v_name, 'agent') || ' - ' || v_reason
    ),
    jsonb_build_object(
      'user_id', v_uid, 'amount', v_disbursed, 'direction', 'cash_in',
      'category', 'equipment_expense', 'ledger_scope', 'platform',
      'source_table', 'merchandise_sales', 'source_id', p_sale_id,
      'reference_id', v_ref, 'currency', 'UGX', 'transaction_date', now(),
      'description', 'Bike lease cancelled: funding reversed for ' || COALESCE(v_name, 'agent')
    )
  );

  v_group := public.create_ledger_transaction(v_entries, v_ref);

  -- Plan first (status 'cancelled' keeps trg_bike_plan_complete_at_zero from "completing" it
  -- and notifying the agent that the lease is fully paid), then the sale.
  UPDATE public.merchandise_recovery_plans
  SET status = 'cancelled', outstanding_balance = 0, due_balance = 0,
      recovery_hold = true,
      recovery_hold_reason = 'Lease cancelled by CFO: ' || v_reason
  WHERE id = v_plan.id;

  UPDATE public.merchandise_sales
  SET order_status = 'rejected',
      rejection_reason = 'Cancelled after disbursement: ' || v_reason,
      amount_outstanding = 0,
      amount_paid = 0,
      lease_activated_at = NULL,
      notes = COALESCE(notes, '') || ' | CFO cancelled lease ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' - disbursement ' || to_char(v_disbursed, 'FM999,999,999')
              || ' clawed back, repayments ' || to_char(v_refund, 'FM999,999,999') || ' refunded - ' || v_reason
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_cfo_cancelled', 'merchandise_sales', p_sale_id, v_reason,
            jsonb_build_object('agent_id', v_agent, 'clawed_back', v_disbursed, 'refunded', v_refund,
                               'plan_id', v_plan.id, 'ledger_group_id', v_group, 'reference_id', v_ref,
                               'previous_outstanding', v_plan.outstanding_balance));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id, 'order_status', 'rejected', 'agent_id', v_agent,
    'clawed_back', v_disbursed, 'refunded', v_refund,
    'net_wallet_change', v_refund - v_disbursed, 'ledger_group_id', v_group
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cfo_cancel_bike_lease(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_cancel_bike_lease(uuid, text) TO authenticated;
