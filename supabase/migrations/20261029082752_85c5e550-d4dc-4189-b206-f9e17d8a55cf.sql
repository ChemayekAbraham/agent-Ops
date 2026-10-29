-- SUPERSEDED by the next migration: self-requests are now always allowed (old ID kept for comparison).
-- identity has not yet been verified for withdrawals. identity_already_verified__impl is
-- the same test used everywhere else: a verified payout destination plus ID and selfie
-- photos on file. Once that is true, the self-request stays blocked so a verified
-- identity cannot be cleared and replaced by its owner; another reviewer must do it.
CREATE OR REPLACE FUNCTION public.agent_vetting_request_id_reupload(p_agent_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v        public.agent_vetting;
  p        public.profiles;
  v_was    boolean;
BEGIN
  IF NOT public.is_agent_vetting_reviewer(v_uid) THEN
    RAISE EXCEPTION 'Only Agent Ops can ask an agent to re-upload their National ID.' USING ERRCODE = '42501';
  END IF;
  -- Self-requests are allowed only before the identity becomes final for withdrawals.
  IF v_uid = p_agent_id AND public.identity_already_verified__impl(p_agent_id) THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Your identity is already verified for withdrawals, so another reviewer must ask for a re-upload.');
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Tell the agent what is wrong with the ID.');
  END IF;

  SELECT * INTO v FROM public.agent_vetting WHERE agent_id = p_agent_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'This agent has not started verification.');
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = p_agent_id FOR UPDATE;
  IF nullif(btrim(coalesce(p.national_id_photo_path, '')), '') IS NULL
     AND nullif(btrim(coalesce(p.national_id_back_photo_path, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'There are no ID photos on file for this agent.');
  END IF;

  v_was := public.identity_already_verified__impl(p_agent_id);

  -- Record the ID on file before it changes (the reopen trigger only does this for
  -- submitted/verified rows).
  PERFORM public._agent_vetting_take_id_snapshot(p_agent_id);

  UPDATE public.profiles
     SET national_id_photo_path = NULL,
         national_id_back_photo_path = NULL,
         id_image_hash = NULL
   WHERE id = p_agent_id;

  PERFORM public._agent_vetting_take_id_snapshot(p_agent_id);

  -- Back to the agent with the reason. reviewed_at is left alone so the next submit
  -- keeps the ID recorded above as the one to compare against.
  UPDATE public.agent_vetting
     SET status = 'rejected', verified_at = NULL, review_note = v_reason, updated_at = now(),
         id_source = coalesce(id_source, v.id_source)
   WHERE agent_id = p_agent_id;

  PERFORM public._agent_vetting_log(p_agent_id, 'id_reupload_requested',
    jsonb_build_object('reason', v_reason, 'previous_status', v.status,
                       'was_identity_verified', v_was));
  RETURN jsonb_build_object('success', true, 'status', 'rejected');
END;
$function$;