CREATE OR REPLACE FUNCTION public.agent_ops_set_agent_frozen(
  p_agent_id uuid,
  p_frozen boolean,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),'');
  v_name text;
BEGIN
  PERFORM public.agent_ops_directory_guard();

  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'agent_id_required'; END IF;

  IF p_frozen THEN
    IF v_reason IS NULL OR char_length(v_reason) < 10 THEN
      RAISE EXCEPTION 'Reason must be at least 10 characters';
    END IF;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_agent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_not_found'; END IF;

  UPDATE public.profiles
     SET is_frozen = p_frozen,
         frozen_reason = CASE WHEN p_frozen THEN v_reason ELSE NULL END,
         frozen_at = CASE WHEN p_frozen THEN now() ELSE NULL END
   WHERE id = p_agent_id;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (
    v_uid,
    CASE WHEN p_frozen THEN 'agent_freeze' ELSE 'agent_unfreeze' END,
    'profiles',
    p_agent_id,
    COALESCE(v_reason, 'Unfrozen by Agent Operations'),
    jsonb_build_object('is_frozen', p_frozen, 'frozen_reason', v_reason)
  );

  RETURN jsonb_build_object('ok', true, 'agent_id', p_agent_id, 'is_frozen', p_frozen, 'full_name', v_name);
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_ops_set_agent_frozen(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_ops_set_agent_frozen(uuid, boolean, text) TO authenticated;