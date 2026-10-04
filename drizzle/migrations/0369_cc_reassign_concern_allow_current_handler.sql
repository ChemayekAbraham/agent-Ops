CREATE OR REPLACE FUNCTION public.cc_reassign_concern(p_concern_id uuid, p_new_forwarded_to uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_actor text;
  v_new_name text;
  v_new_staff uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in again.';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN
    RAISE EXCEPTION 'Write why you are passing this on (at least 10 characters).';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;

  -- The person currently handling it may forward it on; HR, the CEO and super admins may change any handler.
  IF NOT (
    v_row.forwarded_to = v_uid
    OR public.has_role(v_uid, 'hr'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only the person handling this concern, HR or the CEO can forward it.';
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'This concern is already completed.';
  END IF;
  IF v_row.forwarded_to = p_new_forwarded_to THEN
    RAISE EXCEPTION 'That is already the person handling this.';
  END IF;

  SELECT o.full_name, o.staff_id INTO v_new_name, v_new_staff
    FROM public.cc_forward_staff_options() o
   WHERE o.user_id = p_new_forwarded_to;
  IF v_new_name IS NULL THEN
    RAISE EXCEPTION 'That person cannot receive concerns. Choose a staff member with an active employee role.';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Staff member') INTO v_actor
    FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.cc_forwarded_concern_events (
    concern_id, action, actor_id, actor_name, note, reason,
    prev_user_id, prev_user_name, new_user_id, new_user_name
  ) VALUES (
    p_concern_id, 'reassigned', v_uid, v_actor, btrim(p_reason), btrim(p_reason),
    v_row.forwarded_to, v_row.forwarded_to_name, p_new_forwarded_to, v_new_name
  );

  UPDATE public.cc_forwarded_concerns
     SET forwarded_to = p_new_forwarded_to,
         forwarded_to_name = v_new_name,
         forwarded_to_staff_id = v_new_staff,
         original_forwarded_to = coalesce(original_forwarded_to, v_row.forwarded_to),
         original_forwarded_to_name = coalesce(original_forwarded_to_name, v_row.forwarded_to_name),
         reassigned_count = reassigned_count + 1,
         last_reassigned_at = now(),
         last_reassigned_by = v_uid,
         last_reassigned_by_name = v_actor,
         status = 'sent',
         accepted_at = NULL,
         started_at = NULL,
         updated_at = now()
   WHERE id = p_concern_id;

  BEGIN
    INSERT INTO public.system_events (
      event_type, user_id, related_entity_type, related_entity_id, description, metadata
    ) VALUES (
      'role_changed', p_new_forwarded_to, 'cc_forwarded_concerns', p_concern_id,
      format('Calling Center concern reassigned to %s', v_new_name),
      jsonb_build_object(
        'previous_recipient', v_row.forwarded_to,
        'previous_recipient_name', v_row.forwarded_to_name,
        'new_recipient', p_new_forwarded_to,
        'new_recipient_name', v_new_name,
        'changed_by', v_uid,
        'changed_by_name', v_actor,
        'sender', v_row.forwarded_by,
        'reason', btrim(p_reason)
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'previous_recipient_name', v_row.forwarded_to_name,
    'new_recipient_name', v_new_name
  );
END;
$function$;