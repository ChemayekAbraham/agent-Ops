CREATE OR REPLACE FUNCTION public.get_cfo_withdrawable_credits_today_detail(p_categories text[])
 RETURNS TABLE(id uuid, created_at timestamptz, category text, amount numeric, user_id uuid, full_name text, phone text, description text, reference_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_start timestamptz := date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
BEGIN
  IF NOT (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY SELECT g.id, g.created_at, g.category, g.amount, g.user_id, p.full_name, p.phone, g.description, g.reference_id::text
  FROM general_ledger g
  LEFT JOIN profiles p ON p.id = g.user_id
  WHERE g.wallet_bucket='withdrawable' AND g.direction='cash_in' AND g.created_at >= v_start
    AND g.category = ANY(p_categories)
  ORDER BY g.amount DESC
  LIMIT 1000;
END $function$;
REVOKE ALL ON FUNCTION public.get_cfo_withdrawable_credits_today_detail(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_withdrawable_credits_today_detail(text[]) TO authenticated;