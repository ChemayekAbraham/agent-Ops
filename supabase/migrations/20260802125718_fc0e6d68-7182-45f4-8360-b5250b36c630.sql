CREATE OR REPLACE FUNCTION public.welile_home_mark_tenant_verified(p_subscription_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub record;
BEGIN
  SELECT id, tenant_id, agent_id INTO v_sub
  FROM public.welile_homes_subscriptions
  WHERE id = p_subscription_id;

  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Enrollment not found');
  END IF;

  IF v_sub.agent_id <> auth.uid() AND NOT public.is_ops_role(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not permitted');
  END IF;

  UPDATE public.profiles
  SET verified = true
  WHERE id = v_sub.tenant_id;

  RETURN jsonb_build_object('success', true, 'tenant_id', v_sub.tenant_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.welile_home_mark_tenant_verified(uuid) TO authenticated;