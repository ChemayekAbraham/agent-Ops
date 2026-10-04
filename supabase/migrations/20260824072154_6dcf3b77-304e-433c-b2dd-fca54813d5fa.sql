CREATE OR REPLACE FUNCTION public.proxy_cc_resolve_agent(p_agent_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid := COALESCE(p_agent_id, auth.uid());
  v_reviewer boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_reviewer := (
    has_role(v_uid,'super_admin') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'cfo') OR has_role(v_uid,'operations') OR has_role(v_uid,'manager')
    OR has_role(v_uid,'partner_ops') OR has_role(v_uid,'agent_ops')
  );

  IF v_target <> v_uid AND NOT v_reviewer THEN
    RAISE EXCEPTION 'Not authorised to view another proxy agent';
  END IF;

  -- Self-access is reserved for approved proxy agents only.
  IF v_target = v_uid AND NOT v_reviewer AND NOT public.is_approved_proxy_agent(v_uid) THEN
    RAISE EXCEPTION 'Not an approved proxy agent';
  END IF;

  RETURN v_target;
END; $function$;