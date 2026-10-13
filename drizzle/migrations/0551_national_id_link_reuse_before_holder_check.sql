CREATE OR REPLACE FUNCTION public.request_national_id_link(p_nin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_nin text := upper(regexp_replace(coalesce(p_nin,''), '[^A-Za-z0-9]', '', 'g'));
  v_fuzzy text;
  v_holder uuid;
  v_existing public.national_id_link_requests;
  v_count int;
  v_id uuid;
  v_hint jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;
  IF v_nin !~ '^[A-Z0-9]{12,16}$' THEN
    RETURN jsonb_build_object('success', false, 'message', 'A NIN is 12 to 16 letters and numbers.');
  END IF;

  PERFORM public.national_id_link_expire_stale();

  v_fuzzy := public.normalize_national_id_fuzzy(v_nin);
  SELECT * INTO v_existing FROM public.national_id_link_requests
   WHERE requester_id = v_uid AND nin_fuzzy = v_fuzzy
     AND status IN ('awaiting_owner','owner_approved','active')
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'request_id', v_existing.id,
      'status', v_existing.status, 'nin', v_existing.nin, 'reused', true,
      'holder_first_name', NULL,
      'accounts_on_id', NULL);
  END IF;

  SELECT public.duplicate_national_id_owner(v_uid, v_nin) INTO v_holder;
  IF v_holder IS NULL THEN
    RETURN jsonb_build_object('success', false, 'no_holder', true,
      'message', 'That National ID is not recorded on another account.');
  END IF;

  v_hint := public.national_id_holder_hint(v_nin);

  SELECT 1 + count(*) INTO v_count
    FROM public.national_id_link_requests
   WHERE nin_fuzzy = v_fuzzy AND status = 'active';
  IF v_count >= 20 THEN
    RETURN jsonb_build_object('success', false, 'full', true, 'accounts_on_id', v_count,
      'message', 'This National ID has reached its limit of 20 accounts. No more accounts can be added to it.');
  END IF;

  INSERT INTO public.national_id_link_requests (requester_id, holder_id, nin, nin_fuzzy)
  VALUES (v_uid, v_holder, v_nin, v_fuzzy)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_link_requested', 'national_id_link_requests', v_id::text,
          'Account asked to be linked to a National ID already recorded on another account.',
          jsonb_build_object('holder_id', v_holder, 'nin', v_nin));

  RETURN jsonb_build_object('success', true, 'request_id', v_id,
    'status', 'awaiting_owner', 'nin', v_nin,
    'holder_first_name', v_hint->>'holder_first_name',
    'accounts_on_id', v_hint->'accounts_on_id');
END;
$function$;