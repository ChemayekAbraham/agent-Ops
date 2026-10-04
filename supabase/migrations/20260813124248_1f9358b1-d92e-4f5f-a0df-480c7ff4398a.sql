CREATE OR REPLACE FUNCTION public.get_merchant_float_position(p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_float numeric := 0;
  v_reserved numeric := 0;
  v_oop numeric := 0;
  v_oop_review numeric := 0;
  v_headroom numeric := 0;
BEGIN
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agent');
  END IF;

  SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_float
  FROM public.wallets WHERE user_id = v_agent;
  v_float := COALESCE(v_float, 0);

  v_reserved := public.merchant_reserved_float(v_agent);

  SELECT
    COALESCE(SUM(CASE WHEN status = 'pending_reimbursement'
                      THEN shortfall_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'needs_review'
                      THEN shortfall_amount ELSE 0 END), 0)
    INTO v_oop, v_oop_review
  FROM public.merchant_out_of_pocket_advances
  WHERE agent_id = v_agent;

  SELECT COALESCE(NULLIF(btrim(value), '')::numeric, 0) INTO v_headroom
  FROM public.treasury_controls WHERE control_key = 'merchant_out_of_pocket_headroom';
  v_headroom := GREATEST(COALESCE(v_headroom, 0), 0);

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'float_balance', v_float,
    'reserved_float', v_reserved,
    'available_float', GREATEST(v_float - v_reserved, 0),
    'out_of_pocket_outstanding', v_oop,
    'out_of_pocket_under_review', v_oop_review,
    'out_of_pocket_headroom', v_headroom
  );
END;
$function$;