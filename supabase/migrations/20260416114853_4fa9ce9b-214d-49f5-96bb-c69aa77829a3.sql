
-- 1. Update the scalar validate_ledger_category function to include partner_commission
CREATE OR REPLACE FUNCTION public.validate_ledger_category(p_category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
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
    'agent_float_settlement',
    'partner_commission'
  ]);
$$;

-- 2. Update the trigger validate_ledger_category function to include partner_commission
CREATE OR REPLACE FUNCTION public.validate_ledger_category()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed_cats text[] := ARRAY[
    'access_fee_collected','registration_fee_collected',
    'wallet_deposit','tenant_repayment','agent_repayment','partner_funding','share_capital',
    'rent_disbursement','rent_receivable_created','rent_principal_collected',
    'roi_expense','roi_wallet_credit','roi_reinvestment',
    'agent_commission_earned','agent_commission_withdrawal','agent_commission_used_for_rent',
    'wallet_withdrawal','wallet_transfer','wallet_deduction',
    'system_balance_correction','orphan_reassignment','orphan_reversal',
    'agent_float_deposit','agent_float_used_for_rent',
    'pending_portfolio_topup',
    'marketing_expense','payroll_expense','general_admin_expense',
    'research_development_expense','tax_expense','interest_expense','equipment_expense',
    'agent_float_assignment','agent_float_settlement',
    'partner_commission'
  ];
  is_strict boolean;
BEGIN
  SELECT strict_mode INTO is_strict FROM public.treasury_controls LIMIT 1;
  IF is_strict IS TRUE AND NEW.category IS NOT NULL AND NOT (NEW.category = ANY(allowed_cats)) THEN
    RAISE EXCEPTION 'Blocked by treasury strict mode: category "%" not in allowlist', NEW.category;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Update get_agent_split_balances to include partner_commission as commission
CREATE OR REPLACE FUNCTION public.get_agent_split_balances(p_agent_id uuid)
RETURNS TABLE(float_balance numeric, commission_balance numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric := 0;
  v_commission numeric := 0;
BEGIN
  SELECT COALESCE(
    SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),
    0
  ) INTO v_total
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

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
            'agent_advance_credit',
            'partner_commission'
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

  RETURN QUERY SELECT GREATEST(0, v_total - v_commission) AS float_balance, v_commission AS commission_balance;
END;
$$;

-- 4. Update agent_deposit_to_partner to include 2% commission
CREATE OR REPLACE FUNCTION public.agent_deposit_to_partner(
  p_agent_id uuid,
  p_partner_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_balance NUMERIC;
  v_partner_balance NUMERIC;
  v_txn_group UUID := gen_random_uuid();
  v_tracking_id TEXT;
  v_agent_name TEXT;
  v_partner_name TEXT;
  v_commission NUMERIC;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  IF p_agent_id = p_partner_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot deposit to yourself');
  END IF;

  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  IF v_agent_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Agent wallet not found');
  END IF;
  IF v_agent_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient balance. Available: %s', v_agent_balance));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM proxy_agent_assignments
    WHERE agent_id = p_agent_id AND beneficiary_id = p_partner_id
      AND is_active = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active proxy relationship with this partner');
  END IF;

  SELECT full_name INTO v_agent_name FROM profiles WHERE id = p_agent_id;
  SELECT full_name INTO v_partner_name FROM profiles WHERE id = p_partner_id;

  v_tracking_id := 'PDEP-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 8));
  v_commission := p_amount * 0.02;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  -- Leg 1: Deduct from agent wallet
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_agent_id, p_amount, 'cash_out', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit to partner %s — %s', v_partner_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_partner_id);

  -- Leg 2: Credit partner wallet
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_partner_id, p_amount, 'cash_in', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit from agent %s — %s', v_agent_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_agent_id);

  -- Leg 3: Agent commission credit (wallet scope — money we owe agent)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_agent_id, v_commission, 'cash_in', 'partner_commission', 'proxy_agent_assignments', v_tracking_id,
    format('2%% commission on %s deposit to %s', p_amount, v_partner_name),
    'wallet', v_txn_group, 'UGX', p_partner_id);

  -- Leg 4: Platform expense (platform scope — reduces money we have)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_agent_id, v_commission, 'cash_out', 'partner_commission', 'proxy_agent_assignments', v_tracking_id,
    format('Partner commission expense: 2%% of %s for deposit to %s', p_amount, v_partner_name),
    'platform', v_txn_group, 'UGX', p_partner_id);

  -- Update wallet balances
  UPDATE wallets SET balance = balance - p_amount + v_commission, updated_at = NOW() WHERE user_id = p_agent_id;

  INSERT INTO wallets (user_id, balance, currency)
  VALUES (p_partner_id, 0, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE wallets SET balance = balance + p_amount, updated_at = NOW() WHERE user_id = p_partner_id;

  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  SELECT balance INTO v_partner_balance FROM wallets WHERE user_id = p_partner_id;

  -- Audit log
  INSERT INTO system_events (event_type, actor_id, target_id, metadata)
  VALUES ('partner_commission_earned', p_agent_id, p_partner_id,
    jsonb_build_object(
      'deposit_amount', p_amount,
      'commission', v_commission,
      'commission_rate', 0.02,
      'tracking_id', v_tracking_id,
      'partner_name', v_partner_name,
      'txn_group_id', v_txn_group
    ));

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'tracking_id', v_tracking_id,
    'agent_balance_after', v_agent_balance,
    'partner_balance_after', v_partner_balance,
    'partner_name', v_partner_name,
    'txn_group_id', v_txn_group,
    'commission_earned', v_commission
  );
END;
$$;
