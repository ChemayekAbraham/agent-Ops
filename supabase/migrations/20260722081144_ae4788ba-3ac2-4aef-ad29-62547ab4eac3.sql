CREATE OR REPLACE FUNCTION public.get_dispatch_context(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid := auth.uid();
  v_w public.withdrawal_requests%ROWTYPE;
  v_name text;
  v_loc record;
  v_reason_lc text;
  v_initiator text;
  v_kind text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents
     WHERE agent_id = v_agent_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT * INTO v_w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_w.user_id;

  SELECT city, address, latitude, longitude
    INTO v_loc
    FROM public.user_locations
   WHERE user_id = v_w.user_id
   ORDER BY captured_at DESC
   LIMIT 1;

  v_reason_lc := lower(coalesce(v_w.reason, ''));
  v_initiator := lower(coalesce(v_w.metadata->>'initiated_by', ''));

  IF v_initiator LIKE '%proxy%'
     OR v_reason_lc LIKE '%proxy%'
     OR v_reason_lc LIKE '%roi%'
     OR v_reason_lc LIKE '%return%'
     OR v_reason_lc LIKE '%partner%' THEN
    v_kind := 'partner_returns';
  ELSE
    v_kind := 'standard';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'withdrawal_id', v_w.id,
    'amount', v_w.amount,
    'payout_method', v_w.payout_method,
    'status', v_w.status,
    'reason', v_w.reason,
    'dispatch_kind', v_kind,
    'created_at', v_w.created_at,
    'dispatch_expires_at', v_w.dispatch_expires_at,
    'dispatch_claimed_by', v_w.dispatch_claimed_by,
    'customer_name', v_name,
    'city', v_loc.city,
    'address', v_loc.address,
    'latitude', v_loc.latitude,
    'longitude', v_loc.longitude
  );
END;
$function$;