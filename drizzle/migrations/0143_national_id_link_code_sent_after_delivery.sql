-- The "code sent" mark must reflect an SMS that was actually accepted by the
-- gateway, not merely an attempt. Previously the target lookup stamped
-- code_sent_at before the message was sent, so a failed send still showed the
-- asker a code box for a code that never left.

CREATE OR REPLACE FUNCTION public.national_id_link_send_target(p_request_id uuid, p_requester_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.national_id_link_requests;
  v_phone text;
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

  SELECT nullif(btrim(coalesce(phone,'')),'') INTO v_phone FROM public.profiles WHERE id = r.holder_id;
  IF v_phone IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'message', 'The account holding that ID has no phone number on record. Contact Welile Support.');
  END IF;
  SELECT nullif(btrim(coalesce(full_name,'')),'') INTO v_name FROM public.profiles WHERE id = r.requester_id;

  RETURN jsonb_build_object('success', true, 'phone', v_phone,
    'requester_name', coalesce(v_name, 'A Welile user'), 'nin', r.nin);
END;
$function$;

CREATE OR REPLACE FUNCTION public.national_id_link_mark_code_sent(p_request_id uuid, p_requester_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.national_id_link_requests;
BEGIN
  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND requester_id = p_requester_id;
  IF r.id IS NULL OR r.status <> 'awaiting_owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request is closed.');
  END IF;

  UPDATE public.national_id_link_requests
     SET code_sent_at = now(), updated_at = now()
   WHERE id = r.id;

  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.national_id_link_mark_code_sent(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.national_id_link_mark_code_sent(uuid, uuid) TO service_role;