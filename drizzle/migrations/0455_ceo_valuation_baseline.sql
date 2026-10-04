CREATE OR REPLACE FUNCTION public.ceo_valuation_baseline()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s text[] := ARRAY['funded','repaying','completed','disbursed']; r jsonb;
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['ceo','cfo','coo','super_admin','cto']) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT jsonb_build_object(
    'fees_30d', (SELECT coalesce(sum(access_fee+request_fee),0) FROM rent_requests WHERE status = ANY(s) AND created_at > now()-interval '30 days'),
    'fees_prev_30d', (SELECT coalesce(sum(access_fee+request_fee),0) FROM rent_requests WHERE status = ANY(s) AND created_at BETWEEN now()-interval '60 days' AND now()-interval '30 days'),
    'fees_all_time', (SELECT coalesce(sum(access_fee+request_fee),0) FROM rent_requests WHERE status = ANY(s)),
    'rent_30d', (SELECT coalesce(sum(rent_amount),0) FROM rent_requests WHERE status = ANY(s) AND created_at > now()-interval '30 days'),
    'users', (SELECT count(*) FROM profiles),
    'users_30d', (SELECT count(*) FROM profiles WHERE created_at > now()-interval '30 days'),
    'plans_funded', (SELECT count(*) FROM rent_requests WHERE status = ANY(s)),
    'as_of', now()
  ) INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.ceo_valuation_baseline() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ceo_valuation_baseline() TO authenticated;