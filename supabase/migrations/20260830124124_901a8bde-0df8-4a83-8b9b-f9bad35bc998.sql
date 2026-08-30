CREATE OR REPLACE FUNCTION public.partner_ops_find_agent_for_proxy(p_phone text)
RETURNS TABLE(agent_user_id uuid, full_name text, phone text, proxy_status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_term text;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_term := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  IF length(v_term) < 3 THEN
    RAISE EXCEPTION 'Enter at least 3 digits of the phone number';
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone, pai.status
  FROM public.profiles p
  INNER JOIN public.user_roles ur
    ON ur.user_id = p.id AND ur.role = 'agent'::app_role
  LEFT JOIN public.proxy_agent_identity pai
    ON pai.agent_user_id = p.id
  WHERE regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') LIKE '%' || v_term || '%'
  ORDER BY p.full_name
  LIMIT 10;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.partner_ops_find_agent_for_proxy(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.partner_ops_onboard_proxy_agent(
  p_agent_user_id uuid,
  p_nin text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_profile record;
  v_existing record;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT id, full_name, phone INTO v_profile
  FROM public.profiles
  WHERE id = p_agent_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_agent_user_id AND role = 'agent'::app_role
  ) THEN
    RAISE EXCEPTION 'Only users with the agent role can be onboarded as proxy agents';
  END IF;

  SELECT * INTO v_existing
  FROM public.proxy_agent_identity
  WHERE agent_user_id = p_agent_user_id;

  IF FOUND AND v_existing.status = 'approved' THEN
    RAISE EXCEPTION 'This agent is already an approved proxy agent';
  END IF;

  INSERT INTO public.proxy_agent_identity (
    agent_user_id, nin, full_name, phone, status,
    submitted_at, reviewed_by, reviewed_at, review_notes
  ) VALUES (
    p_agent_user_id,
    nullif(btrim(coalesce(p_nin, '')), ''),
    v_profile.full_name,
    v_profile.phone,
    'approved',
    now(),
    auth.uid(),
    now(),
    coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Onboarded directly by Partner Ops')
  )
  ON CONFLICT (agent_user_id) DO UPDATE
    SET status = 'approved',
        nin = coalesce(excluded.nin, proxy_agent_identity.nin),
        full_name = excluded.full_name,
        phone = excluded.phone,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Re-approved directly by Partner Ops');

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    auth.uid(),
    'proxy_agent_onboarded',
    'proxy_agent_identity',
    p_agent_user_id::text,
    coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Proxy agent onboarded directly by Partner Ops'),
    jsonb_build_object('status', 'approved', 'agent_name', v_profile.full_name, 'agent_phone', v_profile.phone)
  );

  RETURN jsonb_build_object('status', 'approved', 'agent_user_id', p_agent_user_id, 'full_name', v_profile.full_name);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.partner_ops_onboard_proxy_agent(uuid, text, text) TO authenticated;