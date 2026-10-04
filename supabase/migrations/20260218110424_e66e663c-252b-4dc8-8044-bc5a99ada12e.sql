
-- =============================================
-- SCALABILITY OPTIMIZATION: Indexes
-- =============================================

-- Profiles: frequent lookups by phone, referrer, last_active
CREATE INDEX IF NOT EXISTS idx_profiles_phone ON public.profiles (phone);
CREATE INDEX IF NOT EXISTS idx_profiles_referrer_id ON public.profiles (referrer_id) WHERE referrer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_last_active ON public.profiles (last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON public.profiles (created_at DESC);

-- User roles: hot path for RLS has_role() checks
CREATE INDEX IF NOT EXISTS idx_user_roles_user_role_enabled ON public.user_roles (user_id, role) WHERE enabled = true;

-- Wallets: balance lookups
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets (user_id);

-- Rent requests: tenant, agent, status filtering
CREATE INDEX IF NOT EXISTS idx_rent_requests_tenant_status ON public.rent_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_rent_requests_agent_id ON public.rent_requests (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rent_requests_status ON public.rent_requests (status);
CREATE INDEX IF NOT EXISTS idx_rent_requests_created_at ON public.rent_requests (created_at DESC);

-- Referrals: leaderboard and lookup
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON public.referrals (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON public.referrals (referred_id);

-- General ledger: user transactions, category filtering
CREATE INDEX IF NOT EXISTS idx_general_ledger_user_date ON public.general_ledger (user_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_general_ledger_category ON public.general_ledger (category, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_general_ledger_source ON public.general_ledger (source_table, source_id);

-- Notifications: user inbox
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON public.notifications (user_id, is_read, created_at DESC);

-- Messages: conversation threads
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_user ON public.conversation_participants (user_id);

-- Agent earnings
CREATE INDEX IF NOT EXISTS idx_agent_earnings_agent ON public.agent_earnings (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_earnings_type ON public.agent_earnings (agent_id, earning_type);

-- Supporter invites
CREATE INDEX IF NOT EXISTS idx_supporter_invites_created_by ON public.supporter_invites (created_by, status);
CREATE INDEX IF NOT EXISTS idx_supporter_invites_phone ON public.supporter_invites (phone);

-- Landlords: tenant lookup
CREATE INDEX IF NOT EXISTS idx_landlords_tenant ON public.landlords (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_landlords_agent ON public.landlords (managed_by_agent_id) WHERE managed_by_agent_id IS NOT NULL;

-- Deposit/withdrawal requests
CREATE INDEX IF NOT EXISTS idx_deposit_requests_user_status ON public.deposit_requests (user_id, status);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_status ON public.withdrawal_requests (user_id, status);

-- Products & orders
CREATE INDEX IF NOT EXISTS idx_products_agent_active ON public.products (agent_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_product_orders_buyer ON public.product_orders (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_orders_agent ON public.product_orders (agent_id, created_at DESC);

-- Push subscriptions: notification delivery
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions (user_id);

-- System events: retention cleanup
CREATE INDEX IF NOT EXISTS idx_system_events_created ON public.system_events (created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_processed ON public.system_events (processed) WHERE processed = false;

-- Agent subagents
CREATE INDEX IF NOT EXISTS idx_agent_subagents_parent ON public.agent_subagents (parent_agent_id);

-- Supporter referrals
CREATE INDEX IF NOT EXISTS idx_supporter_referrals_referrer ON public.supporter_referrals (referrer_id, created_at DESC);

-- Receipt numbers
CREATE INDEX IF NOT EXISTS idx_receipt_numbers_vendor ON public.receipt_numbers (vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_user_receipts_user ON public.user_receipts (user_id, created_at DESC);

-- OTP: lookup by phone
CREATE INDEX IF NOT EXISTS idx_otp_phone_expires ON public.otp_verifications (phone, expires_at DESC);

-- Credit access limits
CREATE INDEX IF NOT EXISTS idx_credit_access_user ON public.credit_access_limits (user_id);

-- =============================================
-- SCALABILITY: Materialized view for dashboard stats
-- =============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.platform_stats AS
SELECT
  (SELECT count(*) FROM public.profiles) AS total_users,
  (SELECT count(*) FROM public.user_roles WHERE role = 'agent' AND enabled = true) AS total_agents,
  (SELECT count(*) FROM public.user_roles WHERE role = 'tenant' AND enabled = true) AS total_tenants,
  (SELECT count(*) FROM public.user_roles WHERE role = 'supporter' AND enabled = true) AS total_supporters,
  (SELECT count(*) FROM public.user_roles WHERE role = 'landlord' AND enabled = true) AS total_landlords,
  (SELECT count(*) FROM public.rent_requests) AS total_rent_requests,
  (SELECT count(*) FROM public.rent_requests WHERE status = 'disbursed') AS active_disbursements,
  (SELECT COALESCE(sum(rent_amount), 0) FROM public.rent_requests WHERE status = 'disbursed') AS total_disbursed_amount,
  now() AS refreshed_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_stats_refresh ON public.platform_stats (refreshed_at);

-- =============================================
-- SCALABILITY: Auto-cleanup old system events (>7 days)
-- =============================================
CREATE OR REPLACE FUNCTION public.cleanup_old_system_events()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.system_events 
  WHERE created_at < now() - interval '7 days';
END;
$$;

-- =============================================
-- SCALABILITY: Auto-cleanup expired OTPs
-- =============================================
CREATE OR REPLACE FUNCTION public.cleanup_expired_otps()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.otp_verifications 
  WHERE expires_at < now() - interval '1 hour';
END;
$$;
