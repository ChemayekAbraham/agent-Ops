-- CMO dashboard "Signup Source Funnel": count only live accounts.
--
-- The function counted every profile row, including ~37,000 soft-deleted bot/fraud accounts
-- (deleted_at set), so "Total Signups" read ~91,800 for May-Oct 2026 while the dashboard's
-- "New Users" card (deleted_at IS NULL) read 54,078. Same rule as the rest of the page.
CREATE OR REPLACE FUNCTION public.signup_source_funnel(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(source text, signups bigint, activated bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  WHERE p.deleted_at IS NULL
    AND p.created_at >= p_start AND p.created_at <= p_end
  GROUP BY 1
  ORDER BY 2 DESC;
END;
$function$;
