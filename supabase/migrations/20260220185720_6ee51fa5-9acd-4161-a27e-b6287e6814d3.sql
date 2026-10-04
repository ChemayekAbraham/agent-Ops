
-- ============================================================
-- DOUBLE-ENTRY LEDGER INFRASTRUCTURE
-- Phase 1: Schema changes, sync trigger, helper functions, opening balances
-- ============================================================

-- 1. Add double-entry columns to general_ledger
ALTER TABLE public.general_ledger 
  ADD COLUMN IF NOT EXISTS account TEXT,
  ADD COLUMN IF NOT EXISTS transaction_group_id UUID;

-- Index for fast balance derivation and transaction grouping
CREATE INDEX IF NOT EXISTS idx_ledger_user_direction ON public.general_ledger (user_id, direction);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction_group ON public.general_ledger (transaction_group_id) WHERE transaction_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_account ON public.general_ledger (account) WHERE account IS NOT NULL;

-- 2. Wallet balance sync trigger (ONLY fires for new double-entry entries with transaction_group_id)
-- This makes wallets.balance a materialized cache of ledger SUM
CREATE OR REPLACE FUNCTION public.sync_wallet_from_ledger()
RETURNS TRIGGER AS $$
BEGIN
  -- Guard: only sync for new-style double-entry entries
  IF NEW.transaction_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Only sync entries tied to a user wallet
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Ensure wallet exists
  INSERT INTO public.wallets (user_id, balance)
  VALUES (NEW.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  -- Increment or decrement based on direction
  IF NEW.direction = 'cash_in' THEN
    UPDATE public.wallets
    SET balance = balance + NEW.amount, updated_at = now()
    WHERE user_id = NEW.user_id;
  ELSIF NEW.direction = 'cash_out' THEN
    UPDATE public.wallets
    SET balance = GREATEST(balance - NEW.amount, 0), updated_at = now()
    WHERE user_id = NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create the trigger
DROP TRIGGER IF EXISTS trg_sync_wallet_from_ledger ON public.general_ledger;
CREATE TRIGGER trg_sync_wallet_from_ledger
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_wallet_from_ledger();

-- 3. Helper function: record a double-entry transaction (paired debit + credit)
CREATE OR REPLACE FUNCTION public.record_double_entry(
  p_debit_user_id UUID,       -- user receiving money (cash_in)
  p_credit_user_id UUID,      -- user sending money (cash_out), NULL for platform/external
  p_amount NUMERIC,
  p_category TEXT,
  p_description TEXT,
  p_source_table TEXT,
  p_source_id UUID DEFAULT NULL,
  p_debit_account TEXT DEFAULT NULL,
  p_credit_account TEXT DEFAULT NULL,
  p_linked_party TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_txn_group_id UUID := gen_random_uuid();
  v_debit_account TEXT;
  v_credit_account TEXT;
BEGIN
  -- Derive account names
  v_debit_account := COALESCE(p_debit_account, 
    CASE WHEN p_debit_user_id IS NOT NULL THEN 'wallet:' || p_debit_user_id::text ELSE 'platform:' || p_category END);
  v_credit_account := COALESCE(p_credit_account, 
    CASE WHEN p_credit_user_id IS NOT NULL THEN 'wallet:' || p_credit_user_id::text ELSE 'platform:' || p_category END);

  -- Debit side (cash_in for the recipient)
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id, linked_party, reference_id,
    account, transaction_group_id
  ) VALUES (
    now(), p_amount, 'cash_in', p_category, p_description,
    p_debit_user_id, p_source_table, p_source_id, p_linked_party, p_reference_id,
    v_debit_account, v_txn_group_id
  );

  -- Credit side (cash_out for the sender)
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id, linked_party, reference_id,
    account, transaction_group_id
  ) VALUES (
    now(), p_amount, 'cash_out', p_category, p_description,
    p_credit_user_id, p_source_table, p_source_id, p_linked_party, p_reference_id,
    v_credit_account, v_txn_group_id
  );

  RETURN v_txn_group_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Function to derive wallet balance from ledger (for verification/auditing)
CREATE OR REPLACE FUNCTION public.get_ledger_balance(p_user_id UUID)
RETURNS NUMERIC AS $$
  SELECT COALESCE(
    SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END) -
    SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END),
    0
  )
  FROM public.general_ledger
  WHERE user_id = p_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 5. Create opening balance entries for all existing wallets
-- These entries bootstrap the ledger with current balances so future
-- derivation from ledger SUM produces correct results
INSERT INTO public.general_ledger (
  transaction_date, amount, direction, category, description,
  user_id, source_table, account, transaction_group_id
)
SELECT 
  now(),
  w.balance,
  'cash_in',
  'opening_balance',
  'Opening balance migration to double-entry ledger',
  w.user_id,
  'migration',
  'wallet:' || w.user_id::text,
  gen_random_uuid()
FROM public.wallets w
WHERE w.balance > 0;

-- Counter-entries for opening balances (platform equity side)
INSERT INTO public.general_ledger (
  transaction_date, amount, direction, category, description,
  user_id, source_table, account, transaction_group_id
)
SELECT 
  now(),
  w.balance,
  'cash_out',
  'opening_balance',
  'Opening balance migration - platform equity',
  NULL,
  'migration',
  'platform:equity',
  -- Match the same transaction_group_id as the debit entry
  gl.transaction_group_id
FROM public.wallets w
JOIN public.general_ledger gl ON gl.user_id = w.user_id 
  AND gl.category = 'opening_balance' 
  AND gl.source_table = 'migration'
  AND gl.direction = 'cash_in'
WHERE w.balance > 0;

-- 6. Make general_ledger truly append-only: prevent UPDATE and DELETE
CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'general_ledger is append-only. Updates and deletes are not allowed. Create reversal entries instead.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON public.general_ledger;
CREATE TRIGGER trg_prevent_ledger_update
  BEFORE UPDATE ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON public.general_ledger;
CREATE TRIGGER trg_prevent_ledger_delete
  BEFORE DELETE ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_ledger_mutation();
