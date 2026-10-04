CREATE OR REPLACE FUNCTION public.agent_ops_set_stage(
  p_agent_profile_id uuid,
  p_stage text,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage text := lower(btrim(p_stage));
  v_current_stage text;
  v_event_id uuid;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN
    RAISE EXCEPTION 'Not authorized to record Agent Operations pipeline stages';
  END IF;

  IF v_stage = 'converted' THEN
    RAISE EXCEPTION 'Converted is derived from the first rent request and cannot be entered manually';
  END IF;

  IF v_stage IS NULL OR v_stage NOT IN ('onboarded', 'training', 'qualified') THEN
    RAISE EXCEPTION 'Stage must be one of onboarded, training, or qualified';
  END IF;

  SELECT e.stage
    INTO v_current_stage
  FROM public.agent_ops_pipeline_stage_events e
  WHERE e.agent_profile_id = p_agent_profile_id
  ORDER BY e.entered_at DESC, e.created_at DESC, e.id DESC
  LIMIT 1;

  IF v_current_stage = v_stage THEN
    RAISE EXCEPTION 'Agent is already in the % stage', v_current_stage;
  END IF;

  INSERT INTO public.agent_ops_pipeline_stage_events (
    agent_profile_id,
    stage,
    set_by,
    note
  )
  VALUES (
    p_agent_profile_id,
    v_stage,
    auth.uid(),
    NULLIF(btrim(p_note), '')
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_ops_set_stage(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_ops_set_stage(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_set_stage(uuid, text, text) TO service_role;