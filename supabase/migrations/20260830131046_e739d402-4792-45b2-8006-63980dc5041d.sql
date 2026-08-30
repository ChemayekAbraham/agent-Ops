DROP FUNCTION IF EXISTS public.partner_ops_find_agent_for_proxy(text);

CREATE OR REPLACE FUNCTION public.partner_ops_find_agent_for_proxy(p_phone text)
RETURNS TABLE(agent_user_id uuid, full_name text, phone text, email text, is_agent boolean, proxy_status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_raw text;
  v_digits text;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_raw := btrim(coalesce(p_phone, ''));
  v_digits := regexp_replace(v_raw, '\D', '', 'g');

  IF length(v_raw) < 3 THEN
    RAISE EXCEPTION 'Enter at least 3 characters (name, email or phone number)';
  END IF;

  RETURN QUERY
  SELECT p.id,
         p.full_name,
         p.phone,
         p.email,
         EXISTS (
           SELECT 1 FROM public.user_roles ur
           WHERE ur.user_id = p.id AND ur.role = 'agent'::app_role
         ) AS is_agent,
         pai.status
  FROM public.profiles p
  LEFT JOIN public.proxy_agent_identity pai
    ON pai.agent_user_id = p.id
  WHERE p.full_name ILIKE '%' || v_raw || '%'
     OR p.email ILIKE '%' || v_raw || '%'
     OR (
       length(v_digits) >= 3
       AND regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') LIKE '%' || v_digits || '%'
     )
  ORDER BY p.full_name
  LIMIT 20;
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
  v_before jsonb := NULL;
  v_agent_role_granted boolean := false;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT id, full_name, phone, email INTO v_profile
  FROM public.profiles
  WHERE id = p_agent_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Any user can be made a proxy agent; grant the agent role when missing so
  -- downstream proxy payout routing keeps working.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_agent_user_id AND role = 'agent'::app_role
  ) THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (p_agent_user_id, 'agent'::app_role)
    ON CONFLICT DO NOTHING;
    v_agent_role_granted := true;
  END IF;

  SELECT * INTO v_existing
  FROM public.proxy_agent_identity
  WHERE agent_user_id = p_agent_user_id;

  IF FOUND THEN
    IF v_existing.status = 'approved' THEN
      RAISE EXCEPTION 'This agent is already an approved proxy agent';
    END IF;
    v_before := jsonb_build_object(
      'status', v_existing.status,
      'full_name', v_existing.full_name,
      'phone', v_existing.phone,
      'nin', v_existing.nin,
      'review_notes', v_existing.review_notes
    );
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

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata, old_values, new_values)
  VALUES (
    auth.uid(),
    'proxy_agent_onboarded',
    'proxy_agent_identity',
    p_agent_user_id::text,
    coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Proxy agent onboarded directly by Partner Ops'),
    jsonb_build_object(
      'status', 'approved',
      'agent_name', v_profile.full_name,
      'agent_phone', v_profile.phone,
      'agent_email', v_profile.email,
      'agent_role_granted', v_agent_role_granted
    ),
    v_before,
    jsonb_build_object(
      'status', 'approved',
      'full_name', v_profile.full_name,
      'phone', v_profile.phone,
      'nin', nullif(btrim(coalesce(p_nin, '')), ''),
      'review_notes', coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Onboarded directly by Partner Ops')
    )
  );

  RETURN jsonb_build_object(
    'status', 'approved',
    'agent_user_id', p_agent_user_id,
    'full_name', v_profile.full_name,
    'email', v_profile.email,
    'phone', v_profile.phone,
    'agent_role_granted', v_agent_role_granted
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.partner_ops_onboard_proxy_agent(uuid, text, text) TO authenticated;