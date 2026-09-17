ALTER TABLE public.national_id_link_requests
  ADD COLUMN IF NOT EXISTS holder_phone text;

COMMENT ON COLUMN public.national_id_link_requests.holder_phone IS
  'Destination number pinned at first send. Never recomputed, so a later profile phone edit cannot redirect the code.';

CREATE OR REPLACE FUNCTION public.national_id_link_send_target(p_request_id uuid, p_requester_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r public.national_id_link_requests;
  v_phone text;
  v_auth_phone text;
  v_profile_phone text;
  v_name text;
BEGIN
  PERFORM public.national_id_link_expire_stale();
  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND requester_id = p_requester_id;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request was not found.');
  END IF;
  IF r.status <> 'awaiting_owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request is no longer waiting for a code.');
  END IF;

  -- 1. Already pinned on this request: always reuse it.
  v_phone := nullif(btrim(coalesce(r.holder_phone, '')), '');

  IF v_phone IS NULL THEN
    -- 2. The number the holder signed in with and confirmed by SMS.
    SELECT nullif(btrim(coalesce(u.phone, '')), '')
      INTO v_auth_phone
      FROM auth.users u
     WHERE u.id = r.holder_id AND u.phone_confirmed_at IS NOT NULL;

    -- 3. Fall back to the profile number only when there is no confirmed login number.
    SELECT nullif(btrim(coalesce(phone, '')), '')
      INTO v_profile_phone
      FROM public.profiles WHERE id = r.holder_id;

    v_phone := coalesce(v_auth_phone, v_profile_phone);

    IF v_phone IS NOT NULL THEN
      UPDATE public.national_id_link_requests
         SET holder_phone = v_phone, updated_at = now()
       WHERE id = r.id;
    END IF;
  END IF;

  IF v_phone IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'message', 'The account holding that ID has no phone number on record. Contact Welile Support.');
  END IF;

  SELECT nullif(btrim(coalesce(full_name,'')),'') INTO v_name FROM public.profiles WHERE id = r.requester_id;

  RETURN jsonb_build_object('success', true, 'phone', v_phone,
    'requester_name', coalesce(v_name, 'A Welile user'), 'nin', r.nin);
END;
$fn$;
