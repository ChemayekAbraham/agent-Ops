CREATE OR REPLACE FUNCTION public.get_coo_transaction_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_commission numeric := 0;
  v_float_used numeric := 0;
  v_float_balance numeric := 0;
  v_float_agents integer := 0;
  v_rent_spend numeric := 0;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
    INTO v_commission
  FROM public.general_ledger
  WHERE category = 'agent_commission_earned'
    AND ledger_scope = 'wallet'
    AND COALESCE(classification, 'production') <> 'admin_correction';

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE -amount END), 0)
    INTO v_float_used
  FROM public.general_ledger
  WHERE category = 'agent_float_used_for_rent'
    AND COALESCE(classification, 'production') <> 'admin_correction';

  SELECT COALESCE(SUM(w.float_balance), 0), COUNT(*)
    INTO v_float_balance, v_float_agents
  FROM public.wallets w
  WHERE EXISTS (
    SELECT 1 FROM public.agent_collections ac WHERE ac.agent_id = w.user_id
  );

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE -amount END), 0)
    INTO v_rent_spend
  FROM public.general_ledger
  WHERE category = 'rent_disbursement'
    AND ledger_scope = 'platform'
    AND COALESCE(classification, 'production') <> 'admin_correction';

  RETURN jsonb_build_object(
    'agent_commission_earned', v_commission,
    'float_used_in_rent', v_float_used,
    'agent_float_balance', v_float_balance,
    'agent_float_agents', v_float_agents,
    'rent_collection_spend', v_rent_spend
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_coo_transaction_kpis() TO authenticated;