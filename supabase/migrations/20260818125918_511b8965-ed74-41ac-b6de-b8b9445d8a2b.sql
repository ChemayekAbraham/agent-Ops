CREATE OR REPLACE FUNCTION public.set_merchant_desk_float_to(p_desk_id uuid, p_agent_id uuid, p_target numeric, p_reason text, p_evidence_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.merchant_float_fix_authorized(v_actor) THEN
    RAISE EXCEPTION 'Only an authorized finance officer can set a merchant desk float';
  END IF;

  RETURN public.set_merchant_desk_float_to_impl(p_desk_id, p_agent_id, p_target, p_reason, p_evidence_note);
END;
$function$;