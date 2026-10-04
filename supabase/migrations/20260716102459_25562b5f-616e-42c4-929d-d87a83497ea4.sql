CREATE OR REPLACE FUNCTION public.tenant_ops_correct_rent_request(
  p_rent_request_id uuid,
  p_rent_amount numeric DEFAULT NULL,
  p_duration_days integer DEFAULT NULL,
  p_access_fee numeric DEFAULT NULL,
  p_request_fee numeric DEFAULT NULL,
  p_total_repayment numeric DEFAULT NULL,
  p_daily_repayment numeric DEFAULT NULL,
  p_amount_repaid numeric DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  rent_amount numeric,
  duration_days integer,
  access_fee numeric,
  request_fee numeric,
  total_repayment numeric,
  daily_repayment numeric,
  amount_repaid numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_before public.rent_requests%ROWTYPE;
  v_reason text := trim(coalesce(p_reason, ''));
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'manager'::public.app_role)
    OR public.has_role(v_actor, 'tenant_operations'::public.app_role)
    OR public.has_role(v_actor, 'operations'::public.app_role)
    OR public.has_role(v_actor, 'coo'::public.app_role)
    OR public.has_role(v_actor, 'super_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to correct rent requests';
  END IF;

  SELECT * INTO v_before
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF p_amount_repaid IS NOT NULL AND p_amount_repaid < 0 THEN
    RAISE EXCEPTION 'Amount repaid cannot be negative';
  END IF;

  IF p_total_repayment IS NOT NULL AND p_total_repayment < 0 THEN
    RAISE EXCEPTION 'Total repayment cannot be negative';
  END IF;

  UPDATE public.rent_requests rr
  SET
    rent_amount = COALESCE(p_rent_amount, rr.rent_amount),
    duration_days = COALESCE(p_duration_days, rr.duration_days),
    access_fee = COALESCE(p_access_fee, rr.access_fee),
    request_fee = COALESCE(p_request_fee, rr.request_fee),
    total_repayment = COALESCE(p_total_repayment, rr.total_repayment),
    daily_repayment = COALESCE(p_daily_repayment, rr.daily_repayment),
    amount_repaid = CASE
      WHEN p_amount_repaid IS NULL THEN rr.amount_repaid
      ELSE LEAST(p_amount_repaid, COALESCE(p_total_repayment, rr.total_repayment, p_amount_repaid))
    END
  WHERE rr.id = p_rent_request_id
  RETURNING rr.id, rr.rent_amount, rr.duration_days, rr.access_fee, rr.request_fee, rr.total_repayment, rr.daily_repayment, rr.amount_repaid, rr.status
  INTO id, rent_amount, duration_days, access_fee, request_fee, total_repayment, daily_repayment, amount_repaid, status;

  INSERT INTO public.audit_logs (action_type, user_id, record_id, table_name, metadata)
  VALUES (
    'tenant_ops_rent_request_correction',
    v_actor,
    p_rent_request_id,
    'rent_requests',
    jsonb_build_object(
      'reason', v_reason,
      'before', jsonb_build_object(
        'rent_amount', v_before.rent_amount,
        'duration_days', v_before.duration_days,
        'access_fee', v_before.access_fee,
        'request_fee', v_before.request_fee,
        'total_repayment', v_before.total_repayment,
        'daily_repayment', v_before.daily_repayment,
        'amount_repaid', v_before.amount_repaid,
        'status', v_before.status
      ),
      'after', jsonb_build_object(
        'rent_amount', rent_amount,
        'duration_days', duration_days,
        'access_fee', access_fee,
        'request_fee', request_fee,
        'total_repayment', total_repayment,
        'daily_repayment', daily_repayment,
        'amount_repaid', amount_repaid,
        'status', status
      )
    )
  );

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.tenant_ops_correct_rent_request(uuid, numeric, integer, numeric, numeric, numeric, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_ops_correct_rent_request(uuid, numeric, integer, numeric, numeric, numeric, numeric, numeric, text) TO service_role;