-- Migration: Ensure pending merchandise/bike orders cannot be deleted,
-- and rejected/failed orders delete cleanly along with all child records.

CREATE OR REPLACE FUNCTION public.agent_cancel_merchandise_order(
  p_sale_id uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale record;
  v_recovered numeric := 0;
  v_plan_ids uuid[];
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
    RAISE EXCEPTION 'You can only delete your own orders';
  END IF;

  -- Pending/in-review orders cannot be deleted; only rejected or failed applications can be removed
  IF COALESCE(v_sale.order_status, 'submitted') NOT IN ('rejected', 'failed') THEN
    RAISE EXCEPTION 'Pending orders cannot be deleted; only rejected or failed orders can be removed';
  END IF;

  -- Safety check: ensure no money was ever collected on this order
  SELECT COALESCE(SUM(amount_recovered), 0) INTO v_recovered
  FROM public.merchandise_recovery_plans
  WHERE sale_id = p_sale_id;

  IF v_recovered > 0 THEN
    RAISE EXCEPTION 'This order has repayments recorded and cannot be deleted';
  END IF;

  -- 1. Remove child records from agent_bike_lease_schedules & agent_bike_leases
  DELETE FROM public.agent_bike_lease_schedules
  WHERE lease_id IN (
    SELECT id FROM public.agent_bike_leases WHERE sale_id = p_sale_id
  );

  DELETE FROM public.agent_bike_leases
  WHERE sale_id = p_sale_id;

  -- 2. Remove smartphone repayment schedules
  DELETE FROM public.smartphone_repayment_schedules
  WHERE sale_id = p_sale_id;

  -- 3. Remove any recovery plan deductions & recovery plans
  SELECT array_agg(id) INTO v_plan_ids
  FROM public.merchandise_recovery_plans
  WHERE sale_id = p_sale_id;

  IF v_plan_ids IS NOT NULL AND array_length(v_plan_ids, 1) > 0 THEN
    DELETE FROM public.merchandise_recovery_deductions
    WHERE plan_id = ANY(v_plan_ids);

    DELETE FROM public.merchandise_recovery_plans
    WHERE id = ANY(v_plan_ids);
  END IF;

  -- 4. Record audit log
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, reason, metadata
  )
  VALUES (
    v_uid,
    'merchandise_order_cancelled_by_customer',
    'merchandise_sales',
    p_sale_id::text,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Rejected order deleted by the agent'),
    jsonb_build_object('old_values', to_jsonb(v_sale))
  );

  -- 5. Delete merchandise sale record
  DELETE FROM public.merchandise_sales WHERE id = p_sale_id;

  RETURN jsonb_build_object(
    'success', true,
    'sale_id', p_sale_id,
    'item_name', v_sale.item_name
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_cancel_merchandise_order(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_cancel_merchandise_order(uuid, text) TO authenticated;
