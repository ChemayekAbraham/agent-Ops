CREATE OR REPLACE FUNCTION public.deduct_agent_float_for_payout(p_payout_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
  v_float_balance numeric;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  IF v_payout.allocation_applied_id IS NOT NULL
     OR v_payout.status IN ('awaiting_agent_receipt','completed')
     OR v_payout.last_attempt_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already_accounted', 'status', v_payout.status);
  END IF;

  IF v_payout.status NOT IN ('otp_verified','pending_merchant_payout','pending_finops_disbursement','disbursing') THEN
    RAISE EXCEPTION 'Payout % not in deductible status (%)', p_payout_id, v_payout.status;
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float
  WHERE agent_id = v_payout.agent_id
  FOR UPDATE;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent % has no float account', v_payout.agent_id;
  END IF;

  IF v_float_balance < v_payout.amount THEN
    RAISE EXCEPTION 'Insufficient float (balance %, requested %)', v_float_balance, v_payout.amount;
  END IF;

  v_new_balance := v_float_balance - v_payout.amount;

  UPDATE public.agent_landlord_float
  SET balance = v_new_balance,
      total_paid_out = COALESCE(total_paid_out, 0) + v_payout.amount,
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  UPDATE public.landlord_payouts
  SET attempts = attempts + 1,
      last_attempt_at = now()
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('ok', true, 'previous_balance', v_float_balance, 'new_balance', v_new_balance, 'deducted', v_payout.amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_single_live_landlord_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing uuid;
  v_status text;
BEGIN
  IF NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;

  SELECT id, status INTO v_existing, v_status
  FROM public.landlord_payouts
  WHERE rent_request_id = NEW.rent_request_id
    AND id <> NEW.id
    AND status IN ('otp_verified','pending_merchant_payout','pending_finops_disbursement','disbursing','awaiting_agent_receipt','completed')
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'This rent cycle already has a landlord payout (%, status %). Refresh your list - this landlord has already been paid for this cycle.', v_existing, v_status
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_single_live_landlord_payout ON public.landlord_payouts;
CREATE TRIGGER trg_enforce_single_live_landlord_payout
BEFORE INSERT ON public.landlord_payouts
FOR EACH ROW EXECUTE FUNCTION public.enforce_single_live_landlord_payout();

WITH repairable AS (
  SELECT lp.id
  FROM public.landlord_payouts lp
  JOIN public.withdrawal_requests w ON w.landlord_payout_id = lp.id
  WHERE lp.status = 'failed'
    AND lp.last_error ILIKE '%not in deductible status%'
    AND w.status = 'completed'
    AND w.payout_proof_path IS NOT NULL
    AND lp.allocation_applied_id IS NOT NULL
)
UPDATE public.landlord_payouts lp
SET status = 'awaiting_agent_receipt',
    last_error = NULL,
    metadata = COALESCE(lp.metadata, '{}'::jsonb) || jsonb_build_object(
      'repaired_false_failure', jsonb_build_object(
        'at', now(),
        'reason', 'money sent and float already debited via allocation; legacy debit RPC status race stamped failed'
      )
    ),
    updated_at = now()
FROM repairable r
WHERE lp.id = r.id;

INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
SELECT NULL, 'landlord_payout_false_failure_repaired', 'landlord_payouts', lp.id::text,
       jsonb_build_object('amount', lp.amount, 'agent_id', lp.agent_id,
                          'reason', 'debit race repair - money sent, float already debited')
FROM public.landlord_payouts lp
WHERE lp.metadata ? 'repaired_false_failure';