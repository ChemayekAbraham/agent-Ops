
-- Disable immutability triggers first
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;

-- Add ledger_scope column
ALTER TABLE public.general_ledger ADD COLUMN IF NOT EXISTS ledger_scope text NOT NULL DEFAULT 'wallet';

-- Index for scope queries
CREATE INDEX IF NOT EXISTS idx_general_ledger_scope ON public.general_ledger (ledger_scope);

-- Backfill platform scope
UPDATE public.general_ledger SET ledger_scope = 'platform'
WHERE category IN (
  'pool_rent_deployment',
  'platform_service_income', 
  'agent_commission_payout',
  'supporter_platform_rewards',
  'transaction_platform_expenses',
  'operational_expenses',
  'opening_balance'
);

-- Backfill bridge scope
UPDATE public.general_ledger SET ledger_scope = 'bridge'
WHERE category IN (
  'supporter_facilitation_capital',
  'rent_facilitation_payout',
  'agent_commission'
);

-- Re-enable immutability triggers
ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
