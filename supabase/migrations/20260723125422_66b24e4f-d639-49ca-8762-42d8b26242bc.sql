CREATE OR REPLACE FUNCTION public.get_withdrawal_recipients(p_ids uuid[])
RETURNS TABLE (id uuid, mobile_money_name text, mobile_money_provider text, payout_method text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.enabled = true
       AND ur.role IN ('manager','operations','cfo','coo','super_admin','cto','financial_ops','partner_ops')
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT wr.id, wr.mobile_money_name, wr.mobile_money_provider, wr.payout_method
      FROM public.withdrawal_requests wr
     WHERE wr.id = ANY(p_ids);
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_withdrawal_recipients(uuid[]) TO authenticated;