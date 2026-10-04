-- 1. Schema additions
ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

ALTER TABLE public.merchandise_sales
  DROP CONSTRAINT IF EXISTS merchandise_sales_order_status_check;
ALTER TABLE public.merchandise_sales
  ADD CONSTRAINT merchandise_sales_order_status_check
    CHECK (order_status = ANY (ARRAY['submitted','processing','completed','failed','rejected']));

-- 2. Reject function
CREATE OR REPLACE FUNCTION public.reject_merchandise_purchase(
  p_sale_id uuid,
  p_reason  text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_sale         record;
  v_plan         record;
  v_refund       numeric := 0;
  v_path         text;
  v_tid          uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'cmo'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CMO, Manager, or Super Admin can reject purchase requests';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A rejection reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_sale
  FROM public.merchandise_sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  -- Idempotent
  IF v_sale.order_status = 'rejected' THEN
    RETURN jsonb_build_object(
      'sale_id', v_sale.id,
      'already_rejected', true,
      'refunded', 0
    );
  END IF;

  IF v_sale.order_status NOT IN ('submitted','processing') THEN
    RAISE EXCEPTION 'Only submitted or processing orders can be rejected (current: %)', v_sale.order_status;
  END IF;

  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'This sale has no linked customer wallet to refund';
  END IF;

  -- Detect refund path via recovery plan
  SELECT * INTO v_plan
  FROM public.merchandise_recovery_plans
  WHERE sale_id = v_sale.id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_path   := 'recovery_plan';
    v_refund := COALESCE(v_plan.amount_recovered, 0);

    -- Cancel the plan
    UPDATE public.merchandise_recovery_plans
    SET status = 'cancelled',
        outstanding_balance = 0,
        updated_at = now()
    WHERE id = v_plan.id;
  ELSE
    v_path   := 'instant';
    v_refund := COALESCE(v_sale.total_revenue, 0);
  END IF;

  -- Refund the wallet via balanced ledger legs (only when there is money to move back)
  IF v_refund > 0 THEN
    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', v_sale.customer_id,
          'ledger_scope', 'wallet',
          'direction', 'cash_in',
          'amount', v_refund,
          'category', 'system_balance_correction',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', v_sale.id,
          'description', 'Merchandise Purchase Refund – ' || v_sale.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'merchandise_purchase_reject',
            'sale_id', v_sale.id,
            'refund_path', v_path,
            'rejected_by', v_uid,
            'reason', p_reason
          )
        ),
        jsonb_build_object(
          'user_id', v_sale.customer_id,
          'ledger_scope', 'platform',
          'direction', 'cash_out',
          'amount', v_refund,
          'category', 'system_balance_correction',
          'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_sales',
          'source_id', v_sale.id,
          'description', 'Merchandise Purchase Refund – ' || v_sale.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'merchandise_purchase_reject',
            'sale_id', v_sale.id,
            'refund_path', v_path,
            'rejected_by', v_uid,
            'reason', p_reason
          )
        )
      ),
      idempotency_key => 'merch_reject_' || v_sale.id::text,
      skip_balance_check => true
    );
  END IF;

  -- Mark the sale rejected
  UPDATE public.merchandise_sales
  SET order_status       = 'rejected',
      rejection_reason   = p_reason,
      rejected_by        = v_uid,
      rejected_at        = now(),
      amount_outstanding = 0,
      updated_at         = now()
  WHERE id = v_sale.id;

  -- Audit trail
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, reason, metadata
  ) VALUES (
    v_uid,
    'merchandise_purchase_rejected',
    'merchandise_sales',
    v_sale.id,
    p_reason,
    jsonb_build_object(
      'refund_path', v_path,
      'refunded', v_refund,
      'item_name', v_sale.item_name,
      'customer_id', v_sale.customer_id
    )
  );

  -- System event (best-effort — do not fail the reject if the events table
  -- validator rejects the payload)
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, metadata)
    VALUES (
      'merchandise.purchase_rejected',
      v_uid,
      jsonb_build_object(
        'sale_id', v_sale.id,
        'customer_id', v_sale.customer_id,
        'item_name', v_sale.item_name,
        'refunded', v_refund,
        'refund_path', v_path,
        'reason', p_reason
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', v_sale.id,
    'refunded', v_refund,
    'refund_path', v_path,
    'already_rejected', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_merchandise_purchase(uuid, text) TO authenticated;