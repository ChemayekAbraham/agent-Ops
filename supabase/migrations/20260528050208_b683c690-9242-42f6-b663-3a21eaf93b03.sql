CREATE OR REPLACE FUNCTION public.ops_update_rent_request_amount(
  p_rent_request_id uuid,
  p_rent_amount numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean;
  v_old numeric;
  v_new_total numeric;
  v_new_daily numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF p_rent_amount IS NULL OR p_rent_amount <= 0 THEN
    RAISE EXCEPTION 'Rent amount must be positive';
  END IF;

  v_is_ops := public.is_ops_role(v_actor);
  IF NOT v_is_ops THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT rent_amount INTO v_old FROM public.rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  -- Trigger trg_enforce_rent_request_formula will recompute daily/total/fees.
  UPDATE public.rent_requests
     SET rent_amount = p_rent_amount,
         updated_at = now()
   WHERE id = p_rent_request_id
   RETURNING total_repayment, daily_repayment INTO v_new_total, v_new_daily;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.update_rent_request_amount', 'rent_requests', p_rent_request_id::text,
    jsonb_build_object(
      'reason', p_reason,
      'old_rent_amount', v_old,
      'new_rent_amount', p_rent_amount,
      'new_total_repayment', v_new_total,
      'new_daily_repayment', v_new_daily
    )
  );

  RETURN jsonb_build_object(
    'rent_amount', p_rent_amount,
    'total_repayment', v_new_total,
    'daily_repayment', v_new_daily
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ops_update_rent_request_amount(uuid, numeric, text) TO authenticated;