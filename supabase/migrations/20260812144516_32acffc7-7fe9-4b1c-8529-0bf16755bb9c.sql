CREATE OR REPLACE FUNCTION public.can_replay_settlement(_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Trusted server-side (service_role) invocation has no auth.uid(); the edge
  -- function performing the call is responsible for its own actor check.
  IF _user_id IS NULL AND current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN true;
  END IF;
  RETURN public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'financial_ops')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin');
END;
$$;