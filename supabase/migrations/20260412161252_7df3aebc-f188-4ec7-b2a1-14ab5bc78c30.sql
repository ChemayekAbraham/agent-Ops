
CREATE OR REPLACE FUNCTION get_platform_cash_summary()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
  wallet_result JSON;
BEGIN
  -- Platform scope: revenue, costs, and recoveries
  SELECT json_build_object(
    'total_revenue', COALESCE(SUM(CASE 
      WHEN direction = 'cash_in' AND category IN (
        'tenant_access_fee','access_fee','tenant_request_fee','request_fee',
        'platform_service_income','landlord_platform_fee','management_fee',
        'access_fee_collected','registration_fee_collected',
        'wallet_deduction'
      )
      THEN amount ELSE 0 END), 0),
    'total_costs', COALESCE(SUM(CASE 
      WHEN direction = 'cash_out' AND category IN (
        'supporter_platform_rewards','supporter_reward','investment_reward',
        'roi_payout','roi_expense',
        'agent_commission_payout','agent_commission','agent_payout',
        'agent_approval_bonus','referral_bonus','agent_commission_earned',
        'transaction_platform_expenses','operational_expenses','platform_expense',
        'system_balance_correction','wallet_deduction'
      )
      THEN amount ELSE 0 END), 0),
    'platform_cash_in', COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END), 0),
    'platform_cash_out', COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END), 0)
  ) INTO result
  FROM general_ledger
  WHERE ledger_scope = 'platform' 
    AND classification IN ('production','legacy_real')
    AND category != 'opening_balance';
    
  -- Wallet/bridge scope totals
  SELECT json_build_object(
    'wallet_cash_in', COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END), 0),
    'wallet_cash_out', COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END), 0)
  ) INTO wallet_result
  FROM general_ledger
  WHERE ledger_scope IN ('wallet','bridge')
    AND classification IN ('production','legacy_real');

  RETURN json_build_object(
    'total_revenue', (result->>'total_revenue')::numeric,
    'total_costs', (result->>'total_costs')::numeric,
    'platform_cash_in', (result->>'platform_cash_in')::numeric,
    'platform_cash_out', (result->>'platform_cash_out')::numeric,
    'wallet_cash_in', (wallet_result->>'wallet_cash_in')::numeric,
    'wallet_cash_out', (wallet_result->>'wallet_cash_out')::numeric
  );
END;
$$;
