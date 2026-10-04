
-- ============================================
-- LEDGER TRANSACTIONS TABLE
-- ============================================
CREATE TABLE public.ledger_transactions (
  transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_group_id uuid,
  description text,
  initiated_by uuid,
  approved_by uuid,
  category text NOT NULL,
  source_table text,
  source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ledger_transactions ENABLE ROW LEVEL SECURITY;

-- Only service role can insert (false blocks all authenticated users)
CREATE POLICY "only_system_creates_transactions"
ON public.ledger_transactions FOR INSERT
WITH CHECK (false);

-- Managers can read all transactions
CREATE POLICY "managers_read_transactions"
ON public.ledger_transactions FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- Immutable: no updates ever
CREATE POLICY "ledger_transactions_immutable"
ON public.ledger_transactions FOR UPDATE
USING (false);

-- Immutable: no deletes ever
CREATE POLICY "ledger_transactions_no_delete"
ON public.ledger_transactions FOR DELETE
USING (false);

-- ============================================
-- LEDGER ENTRIES TABLE (THE HEART)
-- ============================================
CREATE TABLE public.ledger_entries (
  entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.ledger_transactions(transaction_id),
  account_id uuid NOT NULL REFERENCES public.ledger_accounts(account_id),
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount numeric NOT NULL CHECK (amount > 0),
  currency text DEFAULT 'UGX',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

-- Only service role can insert
CREATE POLICY "only_system_creates_ledger_entries"
ON public.ledger_entries FOR INSERT
WITH CHECK (false);

-- No updates ever
CREATE POLICY "ledger_entries_no_update"
ON public.ledger_entries FOR UPDATE
USING (false);

-- No deletes ever
CREATE POLICY "ledger_entries_no_delete"
ON public.ledger_entries FOR DELETE
USING (false);

-- Managers can read all entries
CREATE POLICY "managers_read_ledger_entries"
ON public.ledger_entries FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- Users can read only their own wallet entries
CREATE POLICY "users_read_own_wallet_entries"
ON public.ledger_entries FOR SELECT
USING (
  account_id IN (
    SELECT account_id FROM ledger_accounts
    WHERE owner_id = auth.uid()
      AND group_id IN (
        SELECT group_id FROM ledger_account_groups
        WHERE group_code = 'USER_OWNED'
      )
  )
);

-- ============================================
-- TRANSACTION APPROVALS TABLE
-- ============================================
CREATE TABLE public.transaction_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES public.ledger_transactions(transaction_id),
  approved_by uuid NOT NULL,
  approval_notes text,
  approved_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.transaction_approvals ENABLE ROW LEVEL SECURITY;

-- Only managers can approve
CREATE POLICY "managers_can_approve"
ON public.transaction_approvals FOR INSERT
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

-- Managers can view approvals
CREATE POLICY "managers_view_approvals"
ON public.transaction_approvals FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- Approvals are immutable
CREATE POLICY "approvals_no_update"
ON public.transaction_approvals FOR UPDATE
USING (false);

CREATE POLICY "approvals_no_delete"
ON public.transaction_approvals FOR DELETE
USING (false);

-- ============================================
-- HARDEN LEDGER_ACCOUNTS (replace existing policies)
-- ============================================
DROP POLICY IF EXISTS "Managers can manage accounts" ON public.ledger_accounts;
DROP POLICY IF EXISTS "Managers can view all accounts" ON public.ledger_accounts;
DROP POLICY IF EXISTS "Users can view own accounts" ON public.ledger_accounts;

-- No manual account modification by anyone (service role only)
CREATE POLICY "no_manual_account_insert"
ON public.ledger_accounts FOR INSERT
WITH CHECK (false);

CREATE POLICY "no_direct_balance_updates"
ON public.ledger_accounts FOR UPDATE
USING (false);

CREATE POLICY "no_account_deletion"
ON public.ledger_accounts FOR DELETE
USING (false);

-- Users can view only their own wallet accounts
CREATE POLICY "users_view_own_wallet"
ON public.ledger_accounts FOR SELECT
USING (
  owner_id = auth.uid()
  AND group_id IN (
    SELECT group_id FROM ledger_account_groups
    WHERE group_code = 'USER_OWNED'
  )
);

-- Managers can view all accounts
CREATE POLICY "managers_view_all_accounts"
ON public.ledger_accounts FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- ============================================
-- PREVENT NEGATIVE WALLETS TRIGGER (CRITICAL)
-- ============================================
CREATE OR REPLACE FUNCTION public.prevent_negative_wallets()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_accounts a
    WHERE a.account_id = NEW.account_id
      AND a.allow_negative = false
  ) THEN
    IF (
      COALESCE((
        SELECT sum(
          CASE WHEN direction = 'credit' THEN amount ELSE -amount END
        )
        FROM ledger_entries
        WHERE account_id = NEW.account_id
      ), 0)
      + CASE WHEN NEW.direction = 'credit' THEN NEW.amount ELSE -NEW.amount END
    ) < 0 THEN
      RAISE EXCEPTION 'Wallet balance cannot go negative (account_id: %)', NEW.account_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER enforce_non_negative_wallets
BEFORE INSERT ON public.ledger_entries
FOR EACH ROW
EXECUTE FUNCTION public.prevent_negative_wallets();

-- ============================================
-- PREVENT LEDGER HISTORY TAMPERING (BELT + SUSPENDERS)
-- ============================================
CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ledger entries are immutable. No updates or deletes allowed.';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER block_ledger_entry_update
BEFORE UPDATE ON public.ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

CREATE TRIGGER block_ledger_entry_delete
BEFORE DELETE ON public.ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

CREATE TRIGGER block_ledger_transaction_update
BEFORE UPDATE ON public.ledger_transactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

CREATE TRIGGER block_ledger_transaction_delete
BEFORE DELETE ON public.ledger_transactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();
