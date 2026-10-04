CREATE OR REPLACE FUNCTION public.signup_source_funnel(p_start timestamptz, p_end timestamptz)
RETURNS TABLE(source text, signups bigint, activated bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    has_role(auth.uid(), 'cmo') OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'cto') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo') OR has_role(auth.uid(), 'crm') OR has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(NULLIF(TRIM(p.signup_source), ''), 'direct')::text AS source,
    COUNT(*)::bigint AS signups,
    COUNT(*) FILTER (
      WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = p.id)
    )::bigint AS activated
  FROM profiles p
  WHERE p.created_at >= p_start AND p.created_at <= p_end
  GROUP BY 1
  ORDER BY 2 DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.signup_source_funnel(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.signup_source_funnel(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.signup_source_funnel(timestamptz, timestamptz) TO service_role;