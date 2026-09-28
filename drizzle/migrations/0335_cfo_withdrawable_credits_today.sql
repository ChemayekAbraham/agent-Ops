CREATE OR REPLACE FUNCTION public.get_cfo_withdrawable_credits_today()
RETURNS TABLE(category text, total numeric, credits bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_start timestamptz := date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
BEGIN
  IF NOT (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY SELECT g.category, COALESCE(sum(g.amount),0), count(*)
  FROM general_ledger g
  WHERE g.wallet_bucket='withdrawable' AND g.direction='cash_in' AND g.created_at >= v_start
  GROUP BY g.category ORDER BY 2 DESC;
END $$;
REVOKE ALL ON FUNCTION public.get_cfo_withdrawable_credits_today() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_withdrawable_credits_today() TO authenticated;