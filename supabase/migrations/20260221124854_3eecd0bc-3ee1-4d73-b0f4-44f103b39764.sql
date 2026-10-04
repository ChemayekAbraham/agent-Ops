
-- RPC: get_manager_daily_report
-- Returns priority metrics for the manager daily report dashboard
CREATE OR REPLACE FUNCTION public.get_manager_daily_report()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
BEGIN
  -- Only managers can call this
  IF NOT has_role(auth.uid(), 'manager') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT json_build_object(
    -- 1. Tenants
    'active_tenants', (
      SELECT COUNT(DISTINCT ur.user_id) FROM user_roles ur
      JOIN profiles p ON p.id = ur.user_id
      WHERE ur.role = 'tenant' AND ur.enabled = true
    ),
    'tenants_with_balance', (
      SELECT COUNT(*) FROM (
        SELECT rr.tenant_id, SUM(rr.total_repayment - COALESCE(rr.number_of_payments, 0) * rr.daily_repayment) as balance
        FROM rent_requests rr
        WHERE rr.status IN ('approved', 'funded', 'disbursed')
        GROUP BY rr.tenant_id
        HAVING SUM(rr.total_repayment - COALESCE(rr.number_of_payments, 0) * rr.daily_repayment) > 0
      ) sub
    ),
    'total_rent_balance', (
      SELECT COALESCE(SUM(rr.total_repayment - COALESCE(rr.number_of_payments, 0) * rr.daily_repayment), 0)
      FROM rent_requests rr
      WHERE rr.status IN ('approved', 'funded', 'disbursed')
      AND (rr.total_repayment - COALESCE(rr.number_of_payments, 0) * rr.daily_repayment) > 0
    ),

    -- 2. Landlords
    'active_landlords', (SELECT COUNT(*) FROM landlords WHERE verified = true),
    'total_houses', (SELECT COALESCE(SUM(number_of_houses), 0) FROM landlords WHERE verified = true),
    'total_rent_received', (
      SELECT COALESCE(SUM(gl.amount), 0) FROM general_ledger gl
      WHERE gl.category = 'rent_payment' AND gl.direction = 'cash_out'
    ),

    -- 3. Funders / Supporters
    'active_supporters', (
      SELECT COUNT(DISTINCT ur.user_id) FROM user_roles ur
      WHERE ur.role = 'supporter' AND ur.enabled = true
    ),
    'total_invested', (
      SELECT COALESCE(SUM(gl.amount), 0) FROM general_ledger gl
      WHERE gl.category IN ('investment', 'deposit') AND gl.direction = 'cash_in'
      AND gl.user_id IN (SELECT user_id FROM user_roles WHERE role = 'supporter' AND enabled = true)
    ),
    'supporter_wallets_total', (
      SELECT COALESCE(SUM(w.balance), 0) FROM wallets w
      WHERE w.user_id IN (SELECT user_id FROM user_roles WHERE role = 'supporter' AND enabled = true)
    ),

    -- 4. Agents
    'active_agents', (
      SELECT COUNT(DISTINCT ur.user_id) FROM user_roles ur
      WHERE ur.role = 'agent' AND ur.enabled = true
    ),
    'agent_details', (
      SELECT COALESCE(json_agg(agent_data ORDER BY agent_data.tenant_count DESC), '[]'::json)
      FROM (
        SELECT 
          p.id,
          p.full_name,
          p.avatar_url,
          (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = p.id) as tenant_count,
          COALESCE(w.balance, 0) as wallet_balance,
          COALESCE((SELECT SUM(ae.amount) FROM agent_earnings ae WHERE ae.agent_id = p.id), 0) as total_earnings
        FROM user_roles ur
        JOIN profiles p ON p.id = ur.user_id
        LEFT JOIN wallets w ON w.user_id = p.id
        WHERE ur.role = 'agent' AND ur.enabled = true
        ORDER BY (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = p.id) DESC
        LIMIT 20
      ) agent_data
    ),

    -- 5. Locations
    'locations', (
      SELECT COALESCE(json_agg(loc_data ORDER BY loc_data.tenant_count DESC), '[]'::json)
      FROM (
        SELECT 
          COALESCE(p.city, 'Unknown') as city,
          COUNT(*) as tenant_count
        FROM user_roles ur
        JOIN profiles p ON p.id = ur.user_id
        WHERE ur.role = 'tenant' AND ur.enabled = true
        GROUP BY COALESCE(p.city, 'Unknown')
        ORDER BY COUNT(*) DESC
        LIMIT 15
      ) loc_data
    ),

    -- 6. Platform cash flow (from ledger)
    'platform_cash_in', (
      SELECT COALESCE(SUM(amount), 0) FROM general_ledger WHERE direction = 'cash_in'
    ),
    'platform_cash_out', (
      SELECT COALESCE(SUM(amount), 0) FROM general_ledger WHERE direction = 'cash_out'
    ),

    -- 7. Wallets overview
    'total_wallet_balance', (SELECT COALESCE(SUM(balance), 0) FROM wallets),
    'wallets_with_balance', (SELECT COUNT(*) FROM wallets WHERE balance > 0),
    'wallets_cash_in_today', (
      SELECT COALESCE(SUM(amount), 0) FROM general_ledger 
      WHERE direction = 'cash_in' AND transaction_date >= CURRENT_DATE
    ),
    'wallets_cash_out_today', (
      SELECT COALESCE(SUM(amount), 0) FROM general_ledger 
      WHERE direction = 'cash_out' AND transaction_date >= CURRENT_DATE
    )
  ) INTO result;

  RETURN result;
END;
$$;
