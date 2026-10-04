CREATE OR REPLACE FUNCTION public.get_treasury_snapshot()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cash numeric := 0;
  v_wallets numeric := 0;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'financial_ops'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view treasury snapshot';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
    INTO v_cash
  FROM general_ledger
  WHERE ledger_scope = 'platform'
    AND classification IN ('production','legacy_real')
    AND category <> 'opening_balance';

  SELECT COALESCE(SUM(balance), 0) INTO v_wallets FROM wallets;

  RETURN json_build_object('total_cash', v_cash, 'wallet_total', v_wallets);
END;
$$;

REVOKE ALL ON FUNCTION public.get_treasury_snapshot() FROM public;
GRANT EXECUTE ON FUNCTION public.get_treasury_snapshot() TO authenticated;