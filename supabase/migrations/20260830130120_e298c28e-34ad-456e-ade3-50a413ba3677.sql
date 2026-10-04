CREATE OR REPLACE FUNCTION public.partner_ops_onboard_proxy_agent(p_agent_user_id uuid, p_nin text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profile record;
  v_existing record;
  v_old jsonb;
  v_new jsonb;
  v_notes text;
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

  IF v_existing.agent_user_id IS NOT NULL THEN
    v_old := jsonb_build_object(
      'status', v_existing.status,
      'full_name', v_existing.full_name,
      'phone', v_existing.phone,
      'nin', v_existing.nin,
      'review_notes', v_existing.review_notes
    );
  ELSE
    v_old := NULL;
  END IF;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

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
    coalesce(v_notes, 'Onboarded directly by Partner Ops')
  )
  ON CONFLICT (agent_user_id) DO UPDATE
    SET status = 'approved',
        nin = coalesce(excluded.nin, proxy_agent_identity.nin),
        full_name = excluded.full_name,
        phone = excluded.phone,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Re-approved directly by Partner Ops');

  SELECT jsonb_build_object(
    'status', status,
    'full_name', full_name,
    'phone', phone,
    'nin', nin,
    'review_notes', review_notes
  ) INTO v_new
  FROM public.proxy_agent_identity
  WHERE agent_user_id = p_agent_user_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata, old_values, new_values)
  VALUES (
    auth.uid(),
    'proxy_agent_onboarded',
    'proxy_agent_identity',
    p_agent_user_id::text,
    coalesce(v_notes, 'Proxy agent onboarded directly by Partner Ops'),
    jsonb_build_object('status', 'approved', 'agent_name', v_profile.full_name, 'agent_phone', v_profile.phone,
                       'mode', CASE WHEN v_old IS NULL THEN 'new_registration' ELSE 're_approval' END),
    v_old,
    v_new
  );

  RETURN jsonb_build_object('status', 'approved', 'agent_user_id', p_agent_user_id, 'full_name', v_profile.full_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_ops_proxy_onboarding_audit(p_limit integer DEFAULT 50)
 RETURNS TABLE (
   id uuid,
   action_type text,
   record_id text,
   reason text,
   metadata jsonb,
   old_values jsonb,
   new_values jsonb,
   created_at timestamptz,
   actor_id uuid,
   actor_name text,
   actor_phone text,
   subject_name text,
   subject_phone text
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.id,
         a.action_type,
         a.record_id,
         a.reason,
         a.metadata,
         a.old_values,
         a.new_values,
         a.created_at,
         a.user_id AS actor_id,
         actor.full_name AS actor_name,
         actor.phone AS actor_phone,
         coalesce(subject.full_name, a.metadata->>'agent_name') AS subject_name,
         coalesce(subject.phone, a.metadata->>'agent_phone') AS subject_phone
  FROM public.audit_logs a
  LEFT JOIN public.profiles actor ON actor.id = a.user_id
  LEFT JOIN public.profiles subject
    ON a.record_id ~ '^[0-9a-fA-F-]{36}$' AND subject.id = a.record_id::uuid
  WHERE a.table_name = 'proxy_agent_identity'
    AND (
      public.has_role(auth.uid(), 'super_admin'::app_role)
      OR public.has_role(auth.uid(), 'coo'::app_role)
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'partner_ops'::app_role)
    )
  ORDER BY a.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
$function$;

GRANT EXECUTE ON FUNCTION public.partner_ops_proxy_onboarding_audit(integer) TO authenticated;