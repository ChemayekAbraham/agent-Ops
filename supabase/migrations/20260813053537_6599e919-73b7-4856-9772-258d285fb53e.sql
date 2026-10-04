CREATE OR REPLACE FUNCTION public.merchant_set_payout_numbers(
  p_float_phone text,
  p_personal_phone text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_float text;
  v_personal text;
  v_desk_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  v_float := public.normalize_ug_phone(p_float_phone);
  v_personal := public.normalize_ug_phone(p_personal_phone);

  IF v_float IS NULL OR v_personal IS NULL
     OR v_float !~ '^2567[0-9]{8}$' OR v_personal !~ '^2567[0-9]{8}$' THEN
    RAISE EXCEPTION 'Both numbers must be valid Uganda mobile numbers';
  END IF;

  IF v_float = v_personal THEN
    RAISE EXCEPTION 'The float number and the personal number must be different';
  END IF;

  SELECT id INTO v_desk_id
  FROM public.cashout_agents
  WHERE agent_id = v_uid
  LIMIT 1;

  IF v_desk_id IS NULL THEN
    RAISE EXCEPTION 'You are not a merchant agent';
  END IF;

  UPDATE public.cashout_agents
     SET float_phone = v_float,
         personal_phone = v_personal,
         payout_numbers_set_at = now(),
         payout_numbers_set_by = v_uid,
         updated_at = now()
   WHERE id = v_desk_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  VALUES (
    'merchant_payout_numbers_set',
    'cashout_agents',
    v_desk_id,
    v_uid,
    'Merchant saved float and personal payout numbers',
    jsonb_build_object('float_phone', v_float, 'personal_phone', v_personal)
  );

  RETURN jsonb_build_object('success', true, 'float_phone', v_float, 'personal_phone', v_personal);
END;
$$;

REVOKE ALL ON FUNCTION public.merchant_set_payout_numbers(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.merchant_set_payout_numbers(text, text) TO authenticated;