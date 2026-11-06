-- Reviewers may ask for an ID re-upload on their own record at any time, including after
-- identity was verified for withdrawals. The ID on file is kept as the previous snapshot
-- (prev_id_* columns, files untouched in storage), so the old and new ID images can be
-- compared before the new ID is approved. Self-requests are flagged in the event log.
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

  -- Record the ID on file before it changes so it stays available as "Previous".
  PERFORM public._agent_vetting_take_id_snapshot(p_agent_id);

  UPDATE public.profiles
     SET national_id_photo_path = NULL,
         national_id_back_photo_path = NULL,
         id_image_hash = NULL
   WHERE id = p_agent_id;

  PERFORM public._agent_vetting_take_id_snapshot(p_agent_id);

  UPDATE public.agent_vetting
     SET status = 'rejected', verified_at = NULL, review_note = v_reason, updated_at = now(),
         id_source = coalesce(id_source, v.id_source)
   WHERE agent_id = p_agent_id;

  PERFORM public._agent_vetting_log(p_agent_id, 'id_reupload_requested',
    jsonb_build_object('reason', v_reason, 'previous_status', v.status,
                       'was_identity_verified', v_was,
                       'self_request', v_uid = p_agent_id));
  RETURN jsonb_build_object('success', true, 'status', 'rejected');
END;
$function$;