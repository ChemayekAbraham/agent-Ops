
CREATE OR REPLACE FUNCTION public.auto_activate_merchant_referral(p_referrer uuid)
RETURNS TABLE(activated boolean, cashout_agent_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_referrer_ok boolean;
  v_existing_id uuid;
  v_new_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_referrer IS NULL OR p_referrer = v_uid THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;

  -- Referrer must themselves be an active Merchant Agent
  SELECT EXISTS(
    SELECT 1 FROM public.cashout_agents
    WHERE agent_id = p_referrer AND is_active = true
  ) INTO v_referrer_ok;

  IF NOT v_referrer_ok THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;

  -- Idempotent: if the invited user already has a cashout_agents row, keep it and ensure active
  SELECT id INTO v_existing_id
  FROM public.cashout_agents
  WHERE agent_id = v_uid
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.cashout_agents
       SET is_active = true, updated_at = now()
     WHERE id = v_existing_id AND is_active = false;
    RETURN QUERY SELECT true, v_existing_id;
    RETURN;
  END IF;

  INSERT INTO public.cashout_agents (agent_id, assigned_by, is_active, label)
  VALUES (
    v_uid,
    p_referrer,
    true,
    'Auto-activated via merchant referral'
  )
  RETURNING id INTO v_new_id;

  -- Also ensure the invited user has the 'agent' role so RoleGuard lets them in
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_uid, 'agent')
  ON CONFLICT (user_id, role) DO NOTHING;

  -- Clear the pending flag since they are now an active merchant agent
  UPDATE public.profiles
     SET pending_merchant_agent = false
   WHERE id = v_uid;

  RETURN QUERY SELECT true, v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_activate_merchant_referral(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.auto_activate_merchant_referral(uuid) TO authenticated;
