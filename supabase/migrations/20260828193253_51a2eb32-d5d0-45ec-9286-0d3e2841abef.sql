CREATE OR REPLACE FUNCTION public.growth_commission_next_window(_user_id uuid DEFAULT auth.uid())
RETURNS TABLE (
  eligible boolean,
  window_start timestamptz,
  window_end timestamptz,
  user_count integer,
  rate_per_user numeric,
  amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate numeric;
  v_start timestamptz;
  v_end timestamptz := now();
  v_count integer;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF current_setting('role', true) <> 'service_role'
     AND auth.uid() IS DISTINCT FROM _user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT b.rate_per_user INTO v_rate
  FROM public.growth_commission_beneficiaries b
  WHERE b.user_id = _user_id AND b.active;

  IF v_rate IS NULL THEN
    RETURN QUERY SELECT false, NULL::timestamptz, NULL::timestamptz, 0, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  SELECT max(c.window_end) INTO v_start
  FROM public.growth_commission_claims c
  WHERE c.user_id = _user_id AND c.status <> 'rejected';

  IF v_start IS NULL THEN
    v_start := v_end - interval '30 days';
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public.profiles p
  WHERE p.created_at > v_start AND p.created_at <= v_end;

  RETURN QUERY SELECT true, v_start, v_end, v_count, v_rate, (v_count * v_rate);
END;
$$;

REVOKE ALL ON FUNCTION public.growth_commission_next_window(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.growth_commission_next_window(uuid) TO authenticated, service_role;