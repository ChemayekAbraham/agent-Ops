
-- 1. Add new categories to the validate_ledger_category allowlist
CREATE OR REPLACE FUNCTION public.validate_ledger_category(p_category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_category = ANY(ARRAY[
    'access_fee_collected',
    'registration_fee_collected',
    'wallet_deposit',
    'tenant_repayment',
    'agent_repayment',
    'partner_funding',
    'share_capital',
    'rent_disbursement',
    'rent_receivable_created',
    'rent_principal_collected',
    'roi_expense',
    'roi_wallet_credit',
    'roi_reinvestment',
    'agent_commission_earned',
    'agent_commission_withdrawal',
    'agent_commission_used_for_rent',
    'wallet_withdrawal',
    'wallet_transfer',
    'wallet_deduction',
    'system_balance_correction',
    'orphan_reassignment',
    'orphan_reversal',
    'agent_float_deposit',
    'agent_float_used_for_rent',
    'agent_advance_credit',
    'pending_portfolio_topup',
    'marketing_expense',
    'payroll_expense',
    'general_admin_expense',
    'research_development_expense',
    'tax_expense',
    'interest_expense',
    'equipment_expense',
    'agent_float_assignment',
    'agent_float_settlement'
  ]);
$$;

-- 2. Update get_agent_split_balances to handle new float categories
CREATE OR REPLACE FUNCTION public.get_agent_split_balances(p_agent_id uuid)
RETURNS TABLE(float_balance numeric, commission_balance numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric := 0;
  v_commission numeric := 0;
BEGIN
  -- Total wallet balance
  SELECT COALESCE(
    SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),
    0
  ) INTO v_total
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  -- Commission balance (specific categories only)
  SELECT COALESCE(
    SUM(
      CASE
        WHEN direction IN ('cash_in','credit')
          AND category IN (
            'agent_commission_earned',
            'agent_commission',
            'agent_bonus',
            'referral_bonus',
            'proxy_investment_commission',
            'agent_advance_credit'
          )
        THEN amount
        WHEN direction IN ('cash_out','debit')
          AND category IN (
            'agent_commission_withdrawal',
            'agent_commission_used_for_rent',
            'tenant_default_charge'
          )
        THEN -amount
        ELSE 0
      END
    ),
    0
  ) INTO v_commission
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  -- Float = total - commission (residual; includes agent_float_assignment as cash_in, agent_float_settlement as cash_out)
  RETURN QUERY SELECT v_total - v_commission AS float_balance, v_commission AS commission_balance;
END;
$$;

-- 3. Create get_outstanding_agent_float RPC for finance visibility
CREATE OR REPLACE FUNCTION public.get_outstanding_agent_float()
RETURNS TABLE(
  agent_id uuid,
  agent_name text,
  total_assigned numeric,
  total_settled numeric,
  outstanding numeric,
  oldest_unsettled_at timestamptz,
  age_hours numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH assignments AS (
    SELECT
      gl.user_id,
      COALESCE(SUM(gl.amount), 0) AS total_assigned,
      MIN(gl.created_at) AS first_assignment_at
    FROM general_ledger gl
    WHERE gl.category = 'agent_float_assignment'
      AND gl.direction IN ('cash_in', 'credit')
      AND gl.ledger_scope = 'wallet'
    GROUP BY gl.user_id
  ),
  settlements AS (
    SELECT
      gl.user_id,
      COALESCE(SUM(gl.amount), 0) AS total_settled
    FROM general_ledger gl
    WHERE gl.category = 'agent_float_settlement'
      AND gl.direction IN ('cash_out', 'debit')
      AND gl.ledger_scope = 'wallet'
    GROUP BY gl.user_id
  )
  SELECT
    a.user_id AS agent_id,
    COALESCE(p.full_name, 'Unknown') AS agent_name,
    a.total_assigned,
    COALESCE(s.total_settled, 0) AS total_settled,
    a.total_assigned - COALESCE(s.total_settled, 0) AS outstanding,
    a.first_assignment_at AS oldest_unsettled_at,
    EXTRACT(EPOCH FROM (now() - a.first_assignment_at)) / 3600.0 AS age_hours
  FROM assignments a
  LEFT JOIN settlements s ON s.user_id = a.user_id
  LEFT JOIN profiles p ON p.id = a.user_id
  WHERE a.total_assigned - COALESCE(s.total_settled, 0) > 0
  ORDER BY (a.total_assigned - COALESCE(s.total_settled, 0)) DESC;
END;
$$;
