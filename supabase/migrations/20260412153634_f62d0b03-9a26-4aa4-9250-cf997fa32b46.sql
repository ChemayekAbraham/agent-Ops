
CREATE OR REPLACE FUNCTION public.get_platform_cash_summary()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'total_revenue', COALESCE(SUM(CASE 
      WHEN direction = 'cash_in' AND category IN ('tenant_access_fee','access_fee','tenant_request_fee','request_fee','platform_service_income','landlord_platform_fee','management_fee')
      THEN amount ELSE 0 END), 0),
    'total_costs', COALESCE(SUM(CASE 
      WHEN direction = 'cash_out' AND category IN ('supporter_platform_rewards','supporter_reward','investment_reward','roi_payout','agent_commission_payout','agent_commission','agent_payout','agent_approval_bonus','referral_bonus','transaction_platform_expenses','operational_expenses','platform_expense')
      THEN amount ELSE 0 END), 0),
    'wallet_cash_in', COALESCE(SUM(CASE 
      WHEN direction = 'cash_in' AND ledger_scope IN ('wallet','bridge')
      THEN amount ELSE 0 END), 0),
    'wallet_cash_out', COALESCE(SUM(CASE 
      WHEN direction = 'cash_out' AND ledger_scope IN ('wallet','bridge')
      THEN amount ELSE 0 END), 0)
  ) INTO result
  FROM general_ledger
  WHERE ledger_scope = 'platform' 
    AND classification IN ('production','legacy_real')
    AND category != 'opening_balance';
    
  -- Get wallet/bridge scope totals separately (no ledger_scope filter on platform)
  SELECT json_build_object(
    'total_revenue', (result->>'total_revenue')::numeric,
    'total_costs', (result->>'total_costs')::numeric,
    'wallet_cash_in', COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END), 0),
    'wallet_cash_out', COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END), 0)
  ) INTO result
  FROM general_ledger
  WHERE ledger_scope IN ('wallet','bridge')
    AND classification IN ('production','legacy_real');
  
  RETURN result;
END;
$$;
