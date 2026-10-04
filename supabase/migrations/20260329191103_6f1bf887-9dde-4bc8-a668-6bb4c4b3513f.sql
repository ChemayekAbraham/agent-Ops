
-- 1. Add locked_balance to wallets table
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS locked_balance numeric NOT NULL DEFAULT 0;

-- 2. Critical indexes on wallet_transactions (currently only has pkey!)
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_sender_id ON public.wallet_transactions (sender_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_recipient_id ON public.wallet_transactions (recipient_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON public.wallet_transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_sender_created ON public.wallet_transactions (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_recipient_created ON public.wallet_transactions (recipient_id, created_at DESC);

-- 3. Add indexes on other heavily queried tables
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON public.withdrawal_requests (status);
CREATE INDEX IF NOT EXISTS idx_rent_requests_status ON public.rent_requests (status);
CREATE INDEX IF NOT EXISTS idx_rent_requests_tenant_id ON public.rent_requests (tenant_id);
CREATE INDEX IF NOT EXISTS idx_pending_wallet_ops_status ON public.pending_wallet_operations (status);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON public.notifications (user_id, is_read);

-- 4. Partial indexes for most common query patterns
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_pending ON public.withdrawal_requests (created_at DESC) WHERE status IN ('pending', 'manager_approved', 'cfo_approved');
CREATE INDEX IF NOT EXISTS idx_rent_requests_active ON public.rent_requests (created_at DESC) WHERE status IN ('pending', 'approved', 'funded', 'disbursed');
