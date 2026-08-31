CREATE OR REPLACE FUNCTION public.ops_sync_rent_request_status_to_balance(p_rent_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_outstanding numeric;
BEGIN
  SELECT * INTO r FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_outstanding := GREATEST(COALESCE(r.total_repayment,0) - COALESCE(r.amount_repaid,0), 0);

  IF v_outstanding > 0 AND r.status = 'completed' THEN
    UPDATE public.rent_requests
      SET status = 'repaying',
          tenancy_status = COALESCE(tenancy_status, 'active'),
          updated_at = now()
      WHERE id = p_rent_request_id;
  ELSIF v_outstanding = 0 AND r.status = 'repaying' THEN
    UPDATE public.rent_requests
      SET status = 'completed',
          updated_at = now()
      WHERE id = p_rent_request_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.ops_sync_rent_request_status_to_balance(uuid) FROM PUBLIC;

-- Call the sync at the end of the Tenant Ops balance edit
CREATE OR REPLACE FUNCTION public.ops_edit_tenant_balance(
  p_rent_request_id uuid,
  p_new_rent_amount numeric,
  p_new_outstanding numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_editor_name text;
  r record;
  v_new_rent numeric;
  v_new_access numeric;
  v_new_request numeric;
  v_new_total numeric;
  v_new_repaid numeric;
  v_new_daily numeric;
  v_new_outstanding numeric;
  v_duration integer;
  v_status text;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO r FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  v_duration := GREATEST(COALESCE(r.duration_days, 1), 1);
  v_new_rent := COALESCE(p_new_rent_amount, r.rent_amount);
  IF v_new_rent <= 0 THEN
    RAISE EXCEPTION 'Rent amount must be greater than zero';
  END IF;

  IF p_new_rent_amount IS NOT NULL AND p_new_rent_amount <> r.rent_amount THEN
    IF COALESCE(r.rent_amount,0) > 0 THEN
      v_new_access := round(COALESCE(r.access_fee,0) * v_new_rent / r.rent_amount);
    ELSE
      v_new_access := round(v_new_rent * (power(1.33, v_duration::numeric / 30) - 1));
    END IF;
    v_new_request := CASE WHEN v_new_rent <= 200000 THEN 10000 ELSE 20000 END;
    v_new_total := v_new_rent + v_new_access + v_new_request;
    v_new_daily := ceil(v_new_total / v_duration);
  ELSE
    v_new_access := r.access_fee;
    v_new_request := r.request_fee;
    v_new_total := r.total_repayment;
    v_new_daily := r.daily_repayment;
  END IF;

  IF p_new_outstanding IS NOT NULL THEN
    IF p_new_outstanding < 0 THEN
      RAISE EXCEPTION 'Outstanding balance cannot be negative';
    END IF;
    v_new_repaid := LEAST(GREATEST(v_new_total - p_new_outstanding, 0), v_new_total);
  ELSE
    v_new_repaid := LEAST(COALESCE(r.amount_repaid,0), v_new_total);
  END IF;

  v_new_outstanding := GREATEST(v_new_total - v_new_repaid, 0);

  UPDATE public.rent_requests
  SET rent_amount = v_new_rent,
      access_fee = v_new_access,
      request_fee = v_new_request,
      total_repayment = v_new_total,
      daily_repayment = v_new_daily,
      amount_repaid = v_new_repaid,
      updated_at = now()
  WHERE id = p_rent_request_id;

  SELECT full_name INTO v_editor_name FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.tenant_balance_edits (
    rent_request_id, tenant_id, agent_id, editor_id, editor_name,
    old_rent_amount, new_rent_amount,
    old_total_repayment, new_total_repayment,
    old_amount_repaid, new_amount_repaid,
    old_daily_repayment, new_daily_repayment,
    reason
  ) VALUES (
    p_rent_request_id, r.tenant_id, COALESCE(r.assigned_agent_id, r.agent_id), v_uid, v_editor_name,
    r.rent_amount, v_new_rent,
    r.total_repayment, v_new_total,
    COALESCE(r.amount_repaid,0), v_new_repaid,
    r.daily_repayment, v_new_daily,
    trim(p_reason)
  );

  -- Keep the plan status truthful about whether money is still owed
  PERFORM public.ops_sync_rent_request_status_to_balance(p_rent_request_id);
  SELECT status INTO v_status FROM public.rent_requests WHERE id = p_rent_request_id;

  RETURN jsonb_build_object(
    'rent_request_id', p_rent_request_id,
    'rent_amount', v_new_rent,
    'total_repayment', v_new_total,
    'amount_repaid', v_new_repaid,
    'daily_repayment', v_new_daily,
    'outstanding', v_new_outstanding,
    'status', v_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_edit_tenant_balance(uuid, numeric, numeric, text) TO authenticated;

-- Namuli Roy: plan still carries UGX 419,000 owed, so it must read as repaying
SELECT public.ops_sync_rent_request_status_to_balance('e0be73f2-eb3a-46b4-938c-0fab24a7f46b'::uuid);