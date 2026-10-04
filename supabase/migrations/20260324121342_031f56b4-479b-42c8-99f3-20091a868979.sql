
-- ============================================
-- 1. SUSPENSE LEDGER - Unmatched/unknown funds
-- ============================================
CREATE TABLE public.suspense_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC NOT NULL,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  reference_id TEXT,
  depositor_phone TEXT,
  depositor_name TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched',
  matched_to_user_id UUID REFERENCES public.profiles(id),
  matched_at TIMESTAMPTZ,
  matched_by UUID REFERENCES public.profiles(id),
  refunded_at TIMESTAMPTZ,
  written_off_at TIMESTAMPTZ,
  written_off_by UUID REFERENCES public.profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.suspense_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view suspense_ledger" ON public.suspense_ledger
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations'));

CREATE POLICY "Staff can insert suspense_ledger" ON public.suspense_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations'));

CREATE POLICY "Staff can update suspense_ledger" ON public.suspense_ledger
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations'));

-- ============================================
-- 2. DEFAULT & RECOVERY LEDGER
-- ============================================
CREATE TABLE public.default_recovery_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.profiles(id),
  agent_id UUID REFERENCES public.profiles(id),
  rent_request_id UUID REFERENCES public.rent_requests(id),
  default_amount NUMERIC NOT NULL DEFAULT 0,
  recovered_amount NUMERIC NOT NULL DEFAULT 0,
  written_off_amount NUMERIC NOT NULL DEFAULT 0,
  platform_loss NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'defaulted',
  default_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_recovery_date TIMESTAMPTZ,
  write_off_date TIMESTAMPTZ,
  write_off_approved_by UUID REFERENCES public.profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.default_recovery_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view default_recovery_ledger" ON public.default_recovery_ledger
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'coo'));

CREATE POLICY "Staff can insert default_recovery_ledger" ON public.default_recovery_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Staff can update default_recovery_ledger" ON public.default_recovery_ledger
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ============================================
-- 3. SUPPORTER CAPITAL LEDGER
-- ============================================
CREATE TABLE public.supporter_capital_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supporter_id UUID NOT NULL REFERENCES public.profiles(id),
  transaction_type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  balance_after NUMERIC NOT NULL DEFAULT 0,
  reference_id TEXT,
  rent_request_id UUID REFERENCES public.rent_requests(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.supporter_capital_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Supporters see own capital ledger" ON public.supporter_capital_ledger
  FOR SELECT TO authenticated
  USING (supporter_id = auth.uid() OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Staff can insert supporter_capital_ledger" ON public.supporter_capital_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ============================================
-- 4. COMMISSION ACCRUAL LEDGER
-- ============================================
CREATE TABLE public.commission_accrual_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id),
  source_type TEXT NOT NULL,
  source_id UUID,
  tenant_id UUID REFERENCES public.profiles(id),
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'earned',
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES public.profiles(id),
  paid_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.commission_accrual_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see own commissions" ON public.commission_accrual_ledger
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations'));

CREATE POLICY "System can insert commissions" ON public.commission_accrual_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Staff can update commissions" ON public.commission_accrual_ledger
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ============================================
-- 5. FEE REVENUE LEDGER
-- ============================================
CREATE TABLE public.fee_revenue_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id UUID REFERENCES public.rent_requests(id),
  tenant_id UUID REFERENCES public.profiles(id),
  fee_type TEXT NOT NULL,
  total_amount NUMERIC NOT NULL,
  recognized_amount NUMERIC NOT NULL DEFAULT 0,
  deferred_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'deferred',
  recognition_date TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.fee_revenue_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view fee_revenue_ledger" ON public.fee_revenue_ledger
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'coo'));

CREATE POLICY "Staff can insert fee_revenue_ledger" ON public.fee_revenue_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Staff can update fee_revenue_ledger" ON public.fee_revenue_ledger
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

-- ============================================
-- 6. SETTLEMENT RECONCILIATION LEDGER
-- ============================================
CREATE TABLE public.settlement_reconciliation_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  period_date DATE NOT NULL,
  external_reference TEXT,
  external_amount NUMERIC NOT NULL DEFAULT 0,
  system_amount NUMERIC NOT NULL DEFAULT 0,
  discrepancy_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  reconciled_at TIMESTAMPTZ,
  reconciled_by UUID REFERENCES public.profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.settlement_reconciliation_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view settlement_reconciliation" ON public.settlement_reconciliation_ledger
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations'));

CREATE POLICY "Staff can insert settlement_reconciliation" ON public.settlement_reconciliation_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations'));

CREATE POLICY "Staff can update settlement_reconciliation" ON public.settlement_reconciliation_ledger
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations'));

-- ============================================
-- INDEXES for performance
-- ============================================
CREATE INDEX idx_suspense_status ON public.suspense_ledger(status);
CREATE INDEX idx_suspense_created ON public.suspense_ledger(created_at DESC);
CREATE INDEX idx_default_recovery_status ON public.default_recovery_ledger(status);
CREATE INDEX idx_default_recovery_tenant ON public.default_recovery_ledger(tenant_id);
CREATE INDEX idx_supporter_capital_supporter ON public.supporter_capital_ledger(supporter_id);
CREATE INDEX idx_supporter_capital_created ON public.supporter_capital_ledger(created_at DESC);
CREATE INDEX idx_commission_accrual_agent ON public.commission_accrual_ledger(agent_id);
CREATE INDEX idx_commission_accrual_status ON public.commission_accrual_ledger(status);
CREATE INDEX idx_fee_revenue_status ON public.fee_revenue_ledger(status);
CREATE INDEX idx_fee_revenue_rent ON public.fee_revenue_ledger(rent_request_id);
CREATE INDEX idx_settlement_channel ON public.settlement_reconciliation_ledger(channel);
CREATE INDEX idx_settlement_period ON public.settlement_reconciliation_ledger(period_date DESC);
CREATE INDEX idx_settlement_status ON public.settlement_reconciliation_ledger(status);
