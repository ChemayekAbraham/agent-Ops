CREATE OR REPLACE FUNCTION public.get_cfo_treasury_wallet_flow_summary(
  p_from timestamptz DEFAULT NULL,
  p_include_adjustments boolean DEFAULT false
)
RETURNS TABLE(
  flow_direction text,
  transaction_date timestamptz,
  category text,
  party uuid,
  amount numeric,
  transfer_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role::text IN ('cfo', 'ceo', 'coo', 'manager', 'super_admin', 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT g.*
    FROM public.general_ledger g
    WHERE (p_from IS NULL OR g.transaction_date >= p_from)
      AND (
        p_include_adjustments
        OR NOT (
          g.classification = 'admin_correction'
          OR g.category = 'system_balance_correction'
        )
      )
  ),
  group_flags AS (
    SELECT
      f.transaction_group_id,
      bool_or(f.ledger_scope = 'wallet') AS has_wallet,
      bool_or(f.ledger_scope = 'platform' AND f.direction = 'cash_in') AS has_platform_in,
      bool_or(f.ledger_scope = 'platform' AND f.direction = 'cash_out') AS has_platform_out,
      bool_or(f.ledger_scope = 'bridge' AND f.direction = 'cash_in') AS has_bridge_in,
      (array_agg(f.category ORDER BY f.transaction_date, f.id)
        FILTER (WHERE f.ledger_scope = 'platform' AND f.direction = 'cash_out'))[1] AS platform_out_category
    FROM filtered f
    WHERE f.transaction_group_id IS NOT NULL
    GROUP BY f.transaction_group_id
  ),
  movements AS (
    SELECT
      'to_wallets'::text AS flow_direction,
      f.transaction_date,
      CASE
        WHEN f.category IN ('wallet_deposit', 'wallet_credit', 'system_balance_correction', 'balance_correction', 'wallet_transfer')
          AND gf.platform_out_category IS NOT NULL
          THEN gf.platform_out_category
        WHEN f.category IN ('wallet_deposit', 'wallet_credit', 'system_balance_correction', 'balance_correction', 'wallet_transfer')
          AND f.source_table = 'credit_access_draws' THEN 'credit_access_draw'
        WHEN f.category IN ('wallet_deposit', 'wallet_credit', 'system_balance_correction', 'balance_correction', 'wallet_transfer')
          AND f.source_table = 'business_advances' THEN 'business_advance_disbursement'
        WHEN f.category IN ('wallet_deposit', 'wallet_credit', 'system_balance_correction', 'balance_correction', 'wallet_transfer')
          AND f.source_table = 'agent_advances' THEN 'agent_advance_credit'
        ELSE f.category::text
      END AS category,
      f.user_id AS party,
      f.amount
    FROM filtered f
    JOIN group_flags gf ON gf.transaction_group_id = f.transaction_group_id
    WHERE f.ledger_scope = 'wallet'
      AND f.direction = 'cash_in'
      AND gf.has_platform_out

    UNION ALL

    SELECT
      'to_wallets'::text,
      f.transaction_date,
      f.category::text,
      f.user_id,
      f.amount
    FROM filtered f
    JOIN group_flags gf ON gf.transaction_group_id = f.transaction_group_id
    WHERE NOT gf.has_wallet
      AND f.ledger_scope = 'platform'
      AND f.direction = 'cash_out'
      AND f.category IN (
        'rent_disbursement', 'landlord_float_deposit', 'agent_landlord_float',
        'landlord_float_allocation', 'landlord_payout'
      )

    UNION ALL

    SELECT
      'to_company'::text,
      f.transaction_date,
      f.category::text,
      f.user_id,
      f.amount
    FROM filtered f
    JOIN group_flags gf ON gf.transaction_group_id = f.transaction_group_id
    WHERE f.ledger_scope = 'wallet'
      AND f.direction = 'cash_out'
      AND f.category NOT IN ('wallet_withdrawal', 'withdrawal')
      AND (
        gf.has_platform_in
        OR gf.has_bridge_in
        OR f.category IN (
          'rent_payment_for_tenant', 'agent_float_used_for_rent', 'rent_repayment',
          'tenant_repayment', 'tenant_repayment_collected', 'advance_recovery',
          'agent_repayment', 'agent_advance_repayment', 'salary_advance_repayment',
          'debt_recovery'
        )
      )
  )
  SELECT
    m.flow_direction,
    date_trunc('day', m.transaction_date AT TIME ZONE 'Africa/Kampala')
      AT TIME ZONE 'Africa/Kampala' AS transaction_date,
    m.category,
    m.party,
    sum(m.amount)::numeric AS amount,
    count(*)::bigint AS transfer_count
  FROM movements m
  GROUP BY 1, 2, 3, 4
  ORDER BY 2, 1, 3, 4;
END;
$$;

REVOKE ALL ON FUNCTION public.get_cfo_treasury_wallet_flow_summary(timestamptz, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_treasury_wallet_flow_summary(timestamptz, boolean)
  TO authenticated, service_role;