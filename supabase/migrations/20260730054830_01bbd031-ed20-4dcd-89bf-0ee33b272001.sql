CREATE OR REPLACE FUNCTION public.set_withdrawal_account(
  p_number text,
  p_name text,
  p_provider text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_norm text;
  v_provider text;
  v_name text := btrim(coalesce(p_name, ''));
  v_conflict uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_norm := public.normalize_ug_phone(p_number);
  IF v_norm IS NULL OR length(regexp_replace(v_norm, '\D', '', 'g')) < 9 THEN
    RAISE EXCEPTION 'Enter a valid Ugandan mobile money number';
  END IF;

  IF length(v_name) < 4 OR array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2 THEN
    RAISE EXCEPTION 'Enter the full name exactly as it appears on the mobile money account';
  END IF;

  v_provider := lower(btrim(coalesce(p_provider, '')));
  IF v_provider NOT IN ('mtn', 'airtel') THEN
    RAISE EXCEPTION 'Select MTN or Airtel';
  END IF;

  SELECT id INTO v_conflict
  FROM public.profiles
  WHERE id <> v_uid
    AND mobile_money_number IS NOT NULL
    AND public.normalize_ug_phone(mobile_money_number) = v_norm
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'This mobile money number is already linked to another Welile account';
  END IF;

  UPDATE public.profiles
  SET mobile_money_number = v_norm,
      mobile_money_name = v_name,
      mobile_money_provider = v_provider,
      updated_at = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'mobile_money_number', v_norm,
    'mobile_money_name', v_name,
    'mobile_money_provider', v_provider
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_withdrawal_account(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_withdrawal_account(text, text, text) TO authenticated;