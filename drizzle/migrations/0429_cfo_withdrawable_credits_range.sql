-- CFO withdrawable credits by Kampala-calendar range (today / yesterday / past 7 days / this month).
-- Read-only, role-gated, same shape as get_cfo_withdrawable_credits_today. No data is written.

CREATE OR REPLACE FUNCTION public.get_cfo_withdrawable_credits_range(p_from timestamptz, p_to timestamptz DEFAULT NULL)
 RETURNS TABLE(category text, total numeric, credits bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT g.category, COALESCE(sum(g.amount),0), count(*)
  FROM general_ledger g
  WHERE g.wallet_bucket='withdrawable' AND g.direction='cash_in'
    AND g.created_at >= p_from
    AND (p_to IS NULL OR g.created_at < p_to)
  GROUP BY g.category ORDER BY 2 DESC;
END $function$;
REVOKE ALL ON FUNCTION public.get_cfo_withdrawable_credits_range(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_withdrawable_credits_range(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_cfo_withdrawable_credits_range_detail(p_categories text[], p_from timestamptz, p_to timestamptz DEFAULT NULL)
 RETURNS TABLE(id uuid, created_at timestamptz, category text, amount numeric, user_id uuid, full_name text, phone text, description text, reference_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT g.id, g.created_at, g.category, g.amount, g.user_id, p.full_name, p.phone, g.description, g.reference_id::text
  FROM general_ledger g
  LEFT JOIN profiles p ON p.id = g.user_id
  WHERE g.wallet_bucket='withdrawable' AND g.direction='cash_in'
    AND g.created_at >= p_from
    AND (p_to IS NULL OR g.created_at < p_to)
    AND g.category = ANY(p_categories)
  ORDER BY g.amount DESC
  LIMIT 1000;
END $function$;
REVOKE ALL ON FUNCTION public.get_cfo_withdrawable_credits_range_detail(text[], timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_withdrawable_credits_range_detail(text[], timestamptz, timestamptz) TO authenticated;
