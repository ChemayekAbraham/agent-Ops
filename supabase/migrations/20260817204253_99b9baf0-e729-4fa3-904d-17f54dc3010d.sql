CREATE OR REPLACE FUNCTION public.delete_welile_home_subscription(p_subscription_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subscription public.welile_homes_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_subscription
  FROM public.welile_homes_subscriptions
  WHERE id = p_subscription_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription not found';
  END IF;

  IF NOT COALESCE(v_subscription.agent_id = auth.uid(), false)
     AND NOT COALESCE(v_subscription.enrolled_by = auth.uid(), false)
     AND NOT public.has_role(auth.uid(), 'manager') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  DELETE FROM public.welile_homes_monthly_dues WHERE subscription_id = p_subscription_id;
  DELETE FROM public.welile_homes_enrollment_audit WHERE subscription_id = p_subscription_id;

  DELETE FROM public.welile_homes_subscriptions WHERE id = p_subscription_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_welile_home_subscription(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_welile_home_subscription(uuid) TO service_role;