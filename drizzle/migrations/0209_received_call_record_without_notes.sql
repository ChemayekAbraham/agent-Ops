DROP FUNCTION IF EXISTS public.cc_record_received_call(text,text,text,uuid,text,timestamp with time zone,text,text,timestamp with time zone,text);

CREATE OR REPLACE FUNCTION public.cc_record_received_call(
  p_caller_name text,
  p_concern text,
  p_caller_phone text DEFAULT NULL::text,
  p_linked_user_id uuid DEFAULT NULL::uuid,
  p_linked_kind text DEFAULT NULL::text,
  p_called_at timestamp with time zone DEFAULT now(),
  p_status text DEFAULT 'open'::text,
  p_follow_up_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_follow_up_note text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can record a received call.';
  END IF;
  IF length(btrim(coalesce(p_caller_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Enter the caller''s name.';
  END IF;
  IF length(btrim(coalesce(p_concern, ''))) < 5 THEN
    RAISE EXCEPTION 'Describe what the caller said (at least 5 characters).';
  END IF;

  -- Notes were removed from the received-call recording flow: the concern text
  -- is the single record of what the caller said.
  INSERT INTO public.cc_received_calls (
    recorded_by, recorded_by_name, caller_name, caller_phone, linked_user_id, linked_kind,
    called_at, concern, status, follow_up_at, follow_up_note
  )
  SELECT v_uid, coalesce(nullif(btrim(p.full_name), ''), 'Officer'),
         btrim(p_caller_name), nullif(btrim(coalesce(p_caller_phone,'')), ''),
         p_linked_user_id, p_linked_kind, coalesce(p_called_at, now()),
         btrim(p_concern),
         coalesce(p_status, 'open'), p_follow_up_at, nullif(btrim(coalesce(p_follow_up_note,'')), '')
    FROM public.profiles p WHERE p.id = v_uid
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

GRANT EXECUTE ON FUNCTION public.cc_record_received_call(text,text,text,uuid,text,timestamp with time zone,text,timestamp with time zone,text) TO authenticated, service_role;
