CREATE OR REPLACE FUNCTION public.reject_smartphone_order(p_sale_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.can_review_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to reject smartphone orders';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters';
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'rejected',
      amount_outstanding = 0,
      rejection_reason = btrim(p_reason),
      rejected_by = v_uid,
      rejected_at = now()
  WHERE id = p_sale_id
    AND COALESCE(order_status, 'submitted') IN ('pending_approval', 'submitted');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or already processed';
  END IF;

  -- Cancel any active recovery plan so the lock hook does not keep the button disabled.
  UPDATE public.merchandise_recovery_plans
     SET status = 'cancelled',
         outstanding_balance = 0,
         updated_at = now()
   WHERE sale_id = p_sale_id
     AND status = 'active';

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION public.reject_smartphone_order(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_smartphone_order(uuid, text) TO authenticated;