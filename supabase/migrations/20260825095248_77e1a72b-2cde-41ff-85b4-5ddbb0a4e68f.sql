CREATE OR REPLACE FUNCTION public.delete_agent_product_holdings(
  p_agent_id uuid,
  p_category text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cat text := lower(coalesce(p_category, ''));
  v_ids uuid[];
  v_deleted_sales int := 0;
  v_deleted_plans int := 0;
  v_deleted_deductions int := 0;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'employee')
    OR public.has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete agent product records';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT array_agg(s.id) INTO v_ids
  FROM public.merchandise_sales s
  WHERE s.customer_id = p_agent_id
    AND public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name));

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('deleted_sales', 0, 'deleted_plans', 0, 'deleted_deductions', 0);
  END IF;

  WITH deleted_deductions AS (
    DELETE FROM public.merchandise_recovery_deductions
    WHERE plan_id IN (
      SELECT id FROM public.merchandise_recovery_plans WHERE sale_id = ANY(v_ids)
    )
    RETURNING id
  )
  SELECT count(*) INTO v_deleted_deductions FROM deleted_deductions;

  WITH deleted_plans AS (
    DELETE FROM public.merchandise_recovery_plans WHERE sale_id = ANY(v_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_deleted_plans FROM deleted_plans;

  WITH deleted_sales AS (
    DELETE FROM public.merchandise_sales WHERE id = ANY(v_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_deleted_sales FROM deleted_sales;

  INSERT INTO public.audit_logs (
    action_type,
    table_name,
    record_id,
    actor_id,
    reason,
    metadata
  )
  VALUES (
    'delete',
    'merchandise_sales',
    p_agent_id::text,
    auth.uid(),
    p_reason,
    jsonb_build_object(
      'category', v_cat,
      'deleted_sales', v_deleted_sales,
      'deleted_plans', v_deleted_plans,
      'deleted_deductions', v_deleted_deductions
    )
  );

  RETURN jsonb_build_object(
    'deleted_sales', v_deleted_sales,
    'deleted_plans', v_deleted_plans,
    'deleted_deductions', v_deleted_deductions
  );
END;
$function$;