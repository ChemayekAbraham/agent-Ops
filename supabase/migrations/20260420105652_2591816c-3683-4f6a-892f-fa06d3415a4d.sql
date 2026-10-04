CREATE OR REPLACE FUNCTION public.check_landlord_payout_eligibility(p_agent_id uuid, p_landlord_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
  v_cutoff_ok boolean;
  v_float_ok boolean;
  v_landlord_ok boolean;
BEGIN
  -- Operating window: 06:00 – 22:00 Africa/Kampala (was hour < 10, which blocked
  -- every payout after 10 AM and stranded agent float for the rest of the day).
  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  v_cutoff_ok := v_kampala_hour >= 6 AND v_kampala_hour < 22;

  SELECT verified, phone INTO v_landlord_verified, v_landlord_phone
  FROM public.landlords WHERE id = p_landlord_id;

  v_landlord_ok := COALESCE(v_landlord_verified, false)
                   AND v_landlord_phone IS NOT NULL
                   AND length(trim(v_landlord_phone)) >= 8;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = p_agent_id;
  v_float_ok := COALESCE(v_float_balance, 0) >= p_amount;

  RETURN jsonb_build_object(
    'eligible', v_cutoff_ok AND v_landlord_ok AND v_float_ok,
    'cutoff_ok', v_cutoff_ok,
    'kampala_hour', v_kampala_hour,
    'landlord_verified', v_landlord_ok,
    'landlord_phone_present', v_landlord_phone IS NOT NULL,
    'float_ok', v_float_ok,
    'float_balance', COALESCE(v_float_balance, 0),
    'amount_required', p_amount
  );
END;
$function$;