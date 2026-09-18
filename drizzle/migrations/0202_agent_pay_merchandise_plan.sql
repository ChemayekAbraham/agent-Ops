-- Manual merchandise repayment from the agent's own withdrawable wallet.
-- SECURITY DEFINER: the frontend never writes wallet/ledger state directly.
CREATE OR REPLACE FUNCTION public.agent_pay_merchandise_plan(
  p_plan_id uuid,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan    record;
  v_uid     uuid := auth.uid();
  v_avail   numeric;
  v_amount  numeric;
  v_closing numeric;
  v_ref     uuid := gen_random_uuid();
  v_idem    text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_plan
  FROM public.merchandise_recovery_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
  END IF;

  IF v_plan.customer_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_your_plan');
  END IF;

  IF v_plan.status <> 'active' OR COALESCE(v_plan.outstanding_balance, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'plan_not_active');
  END IF;

  v_amount := floor(COALESCE(p_amount, 0));
  IF v_amount < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  v_avail := GREATEST(0, COALESCE(public.get_user_available_balance(v_uid), 0));
  IF v_avail < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_funds', 'available', v_avail);
  END IF;

  -- Never take more than is owed, and never more than is actually available.
  v_amount := LEAST(v_amount, v_plan.outstanding_balance, v_avail);
  IF v_amount < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_funds', 'available', v_avail);
  END IF;

  v_idem := 'merch_manual_' || v_plan.id::text || '_' || v_amount::bigint::text
            || '_' || to_char(now(), 'YYYYMMDDHH24MI');

  PERFORM public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'wallet',
        'direction', 'cash_out',
        'amount', v_amount,
        'category', 'agent_repayment',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_recovery_plans',
        'source_id', v_plan.id,
        'description', 'Merchandise Payment - ' || COALESCE(v_plan.item_name, 'Item') || ' (paid by agent)',
        'currency', 'UGX',
        'metadata', jsonb_build_object(
          'source', 'merchandise_manual_payment',
          'plan_id', v_plan.id,
          'sale_id', v_plan.sale_id
        )
      ),
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'platform',
        'direction', 'cash_in',
        'amount', v_amount,
        'category', 'agent_repayment',
        'recipient_type', 'operational_wallet',
        'source_table', 'merchandise_recovery_plans',
        'source_id', v_plan.id,
        'description', 'Merchandise cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Item'),
        'currency', 'UGX',
        'metadata', jsonb_build_object(
          'source', 'merchandise_manual_payment',
          'plan_id', v_plan.id,
          'sale_id', v_plan.sale_id,
          'from_customer', v_uid,
          'item_name', v_plan.item_name
        )
      )
    ),
    idempotency_key => v_idem
  );

  v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);

  INSERT INTO public.merchandise_recovery_deductions (
    plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref
  ) VALUES (
    v_plan.id, v_uid, v_plan.item_name, v_amount, v_avail, v_closing, v_ref
  );

  UPDATE public.merchandise_recovery_plans
  SET outstanding_balance = v_closing,
      amount_recovered = COALESCE(amount_recovered, 0) + v_amount,
      last_recovery_at = now(),
      status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END,
      updated_at = now()
  WHERE id = v_plan.id;

  IF v_plan.sale_id IS NOT NULL THEN
    UPDATE public.merchandise_sales
    SET amount_paid = COALESCE(amount_paid, 0) + v_amount,
        amount_outstanding = v_closing,
        payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END,
        updated_at = now()
    WHERE id = v_plan.sale_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amount_paid', v_amount,
    'outstanding_after', v_closing,
    'completed', v_closing <= 0,
    'item_name', v_plan.item_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.agent_pay_merchandise_plan(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_pay_merchandise_plan(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_pay_merchandise_plan(uuid, numeric) TO service_role;
