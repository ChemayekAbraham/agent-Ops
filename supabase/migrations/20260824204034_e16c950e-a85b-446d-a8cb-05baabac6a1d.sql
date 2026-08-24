CREATE OR REPLACE FUNCTION public.agent_cancel_merchandise_order(
  p_sale_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale record;
  v_recovered numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_sale
  FROM public.merchandise_sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_sale.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'You can only cancel your own orders';
  END IF;

  IF COALESCE(v_sale.order_status, 'submitted') NOT IN ('pending_approval', 'submitted', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'Only orders waiting for approval, or rejected/failed orders, can be removed';
  END IF;

  SELECT COALESCE(SUM(amount_recovered), 0) INTO v_recovered
  FROM public.merchandise_recovery_plans
  WHERE sale_id = p_sale_id;

  IF v_recovered > 0 THEN
    RAISE EXCEPTION 'This order is already in repayment and cannot be cancelled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.merchandise_recovery_plans
    WHERE sale_id = p_sale_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'This order has an active recovery plan and cannot be cancelled';
  END IF;

  UPDATE public.merchandise_recovery_plans
     SET status = 'cancelled', updated_at = now()
   WHERE sale_id = p_sale_id AND status <> 'cancelled';

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values)
  VALUES (
    v_uid,
    'merchandise_order_cancelled_by_customer',
    'merchandise_sales',
    p_sale_id,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Order removed by the agent (pending or rejected)'),
    to_jsonb(v_sale)
  );

  DELETE FROM public.merchandise_sales WHERE id = p_sale_id;

  RETURN jsonb_build_object('success', true, 'sale_id', p_sale_id, 'item_name', v_sale.item_name);
END;
$$;

REVOKE ALL ON FUNCTION public.agent_cancel_merchandise_order(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_cancel_merchandise_order(uuid, text) TO authenticated;