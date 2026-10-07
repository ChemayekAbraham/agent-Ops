CREATE OR REPLACE FUNCTION public.agent_cancel_merchandise_order(p_sale_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale record;
  v_status text;
  v_recovered numeric := 0;
  v_progressed int := 0;
  v_sched int := 0; v_leases int := 0; v_plans int := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_sale.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'You can only cancel your own orders';
  END IF;

  v_status := COALESCE(v_sale.order_status, 'submitted');
  IF v_status NOT IN ('pending_approval', 'submitted', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'Only orders waiting for approval, or rejected/failed orders, can be removed';
  END IF;

  -- Pending orders: block once any approval or disbursement happened on the linked lease
  IF v_status IN ('pending_approval', 'submitted') THEN
    SELECT count(*) INTO v_progressed FROM public.agent_bike_leases
     WHERE sale_id = p_sale_id
       AND (ops_approved_at IS NOT NULL OR coo_approved_at IS NOT NULL
            OR cfo_disbursed_at IS NOT NULL OR lease_activated_at IS NOT NULL
            OR COALESCE(disbursed_amount,0) > 0 OR COALESCE(amount_paid,0) > 0);
    IF v_progressed > 0 THEN
      RAISE EXCEPTION 'This application has already been approved or disbursed and can no longer be cancelled';
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount_recovered), 0) INTO v_recovered
    FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id;
  IF v_recovered > 0 THEN
    RAISE EXCEPTION 'This order is already in repayment and cannot be cancelled';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'merchandise_order_cancelled_by_customer', 'merchandise_sales', p_sale_id::text,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Order removed by the agent (pending or rejected)'),
    jsonb_build_object('old_values', to_jsonb(v_sale),
      'leases', (SELECT COALESCE(jsonb_agg(to_jsonb(l)), '[]'::jsonb) FROM public.agent_bike_leases l WHERE l.sale_id = p_sale_id),
      'recovery_plans', (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM public.merchandise_recovery_plans r WHERE r.sale_id = p_sale_id)));

  DELETE FROM public.agent_bike_lease_schedules
   WHERE lease_id IN (SELECT id FROM public.agent_bike_leases WHERE sale_id = p_sale_id);
  GET DIAGNOSTICS v_sched = ROW_COUNT;
  DELETE FROM public.agent_bike_leases WHERE sale_id = p_sale_id;
  GET DIAGNOSTICS v_leases = ROW_COUNT;
  DELETE FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id;
  GET DIAGNOSTICS v_plans = ROW_COUNT;
  DELETE FROM public.merchandise_sales WHERE id = p_sale_id;

  RETURN jsonb_build_object('success', true, 'sale_id', p_sale_id, 'item_name', v_sale.item_name,
    'deleted_schedules', v_sched, 'deleted_leases', v_leases, 'deleted_recovery_plans', v_plans);
END;
$function$;