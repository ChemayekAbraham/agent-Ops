
-- Add column
ALTER TABLE public.general_ledger
ADD COLUMN IF NOT EXISTS classification TEXT DEFAULT 'production';

-- Disable all write-protection triggers
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_guard_ledger_write;
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;

-- Classify legacy_real
UPDATE public.general_ledger SET classification = 'legacy_real'
WHERE category IN (
  'deposit', 'roi_payout', 'agent_commission', 'agent_commission_payout',
  'supporter_facilitation_capital', 'supporter_rent_fund', 'supporter_capital',
  'rent_repayment', 'tenant_access_fee', 'supporter_platform_rewards',
  'agent_proxy_investment', 'proxy_investment_commission', 'agent_investment_commission',
  'rent_payment_for_tenant', 'landlord_rent_payment', 'rent_obligation',
  'rent_obligation_reversal', 'rent_obligation_reversal_adjustment',
  'credit_access_repayment', 'advance_repayment', 'pool_capital_received',
  'pool_rent_deployment', 'pool_rent_deployment_reversal', 'angel_pool_investment',
  'coo_proxy_investment', 'coo_proxy_investment_reversal', 'wallet_to_investment',
  'proxy_partner_withdrawal', 'pending_portfolio_topup', 'rent_float_funding',
  'debt_clearance', 'agent_bonus', 'tenant_default_charge', 'platform_expense',
  'marketing_expense', 'account_merge'
);

-- Classify test_dev
UPDATE public.general_ledger SET classification = 'test_dev'
WHERE category IN ('test_funds_cleanup', 'opening_balance');

-- Classify admin_correction
UPDATE public.general_ledger SET classification = 'admin_correction'
WHERE category IN (
  'balance_correction', 'correction_reversal', '🔧 Manual Adjustment',
  'reconciliation', 'manager_credit', 'manager_debit',
  'wallet_deduction_general_adjustment', 'wallet_deduction_cash_payout_retraction'
);

-- Re-enable all write-protection triggers
ALTER TABLE public.general_ledger ENABLE TRIGGER trg_guard_ledger_write;
ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_general_ledger_classification ON public.general_ledger (classification);
