
-- ============================================================
-- BUSINESS ADVANCE SYSTEM
-- ============================================================

CREATE TYPE public.business_advance_status AS ENUM (
  'pending',
  'agent_ops_approved',
  'tenant_ops_approved',
  'landlord_ops_approved',
  'coo_approved',
  'cfo_disbursed',
  'active',
  'completed',
  'rejected',
  'defaulted'
);

CREATE TABLE public.business_advances (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,

  business_name TEXT NOT NULL,
  business_type TEXT NOT NULL,
  business_address TEXT NOT NULL,
  business_city TEXT,
  business_latitude NUMERIC,
  business_longitude NUMERIC,
  business_photo_urls TEXT[],
  monthly_revenue NUMERIC,
  years_in_business NUMERIC,

  tenant_has_smartphone BOOLEAN NOT NULL DEFAULT true,
  tenant_onboarding_method TEXT NOT NULL DEFAULT 'signup_link',
  tenant_signup_link TEXT,

  principal NUMERIC NOT NULL CHECK (principal > 0),
  outstanding_balance NUMERIC NOT NULL DEFAULT 0,
  total_repaid NUMERIC NOT NULL DEFAULT 0,
  total_interest_accrued NUMERIC NOT NULL DEFAULT 0,
  daily_rate NUMERIC NOT NULL DEFAULT 0.01,

  status public.business_advance_status NOT NULL DEFAULT 'pending',

  agent_ops_reviewed_by UUID,
  agent_ops_reviewed_at TIMESTAMPTZ,
  agent_ops_notes TEXT,

  tenant_ops_reviewed_by UUID,
  tenant_ops_reviewed_at TIMESTAMPTZ,
  tenant_ops_notes TEXT,

  landlord_ops_reviewed_by UUID,
  landlord_ops_reviewed_at TIMESTAMPTZ,
  landlord_ops_notes TEXT,

  coo_approved_by UUID,
  coo_approved_at TIMESTAMPTZ,
  coo_notes TEXT,

  cfo_disbursed_by UUID,
  cfo_disbursed_at TIMESTAMPTZ,
  cfo_notes TEXT,

  rejection_reason TEXT,

  disbursed_at TIMESTAMPTZ,
  last_compounded_date DATE,
  completed_at TIMESTAMPTZ,

  reason TEXT,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_business_advances_tenant ON public.business_advances(tenant_id);
CREATE INDEX idx_business_advances_agent ON public.business_advances(agent_id);
CREATE INDEX idx_business_advances_status ON public.business_advances(status);
CREATE INDEX idx_business_advances_active_compound ON public.business_advances(last_compounded_date) WHERE status = 'active';

CREATE TABLE public.business_advance_repayments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  advance_id UUID NOT NULL REFERENCES public.business_advances(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  agent_id UUID,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  outstanding_before NUMERIC NOT NULL,
  outstanding_after NUMERIC NOT NULL,
  agent_commission NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'wallet',
  reference TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bar_advance ON public.business_advance_repayments(advance_id);
CREATE INDEX idx_bar_agent ON public.business_advance_repayments(agent_id);

CREATE TABLE public.business_advance_daily_accruals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  advance_id UUID NOT NULL REFERENCES public.business_advances(id) ON DELETE CASCADE,
  accrual_date DATE NOT NULL,
  opening_balance NUMERIC NOT NULL,
  interest_accrued NUMERIC NOT NULL,
  closing_balance NUMERIC NOT NULL,
  daily_rate NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(advance_id, accrual_date)
);

CREATE INDEX idx_bada_advance_date ON public.business_advance_daily_accruals(advance_id, accrual_date DESC);

CREATE TRIGGER update_business_advances_updated_at
  BEFORE UPDATE ON public.business_advances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.business_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_advance_repayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_advance_daily_accruals ENABLE ROW LEVEL SECURITY;

-- Helper: any operations staff role
CREATE OR REPLACE FUNCTION public.is_business_advance_ops(_uid UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(_uid, 'manager')
    OR public.has_role(_uid, 'cfo')
    OR public.has_role(_uid, 'coo')
    OR public.has_role(_uid, 'ceo')
    OR public.has_role(_uid, 'super_admin')
    OR public.has_role(_uid, 'operations')
    OR public.has_role(_uid, 'employee')
$$;

-- business_advances policies
CREATE POLICY "Agent views own business advances"
  ON public.business_advances FOR SELECT
  USING (agent_id = auth.uid());

CREATE POLICY "Tenant views own business advances"
  ON public.business_advances FOR SELECT
  USING (tenant_id = auth.uid());

CREATE POLICY "Ops staff views all business advances"
  ON public.business_advances FOR SELECT
  USING (public.is_business_advance_ops(auth.uid()));

CREATE POLICY "Agents create business advance requests"
  ON public.business_advances FOR INSERT
  WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Ops staff updates business advances"
  ON public.business_advances FOR UPDATE
  USING (public.is_business_advance_ops(auth.uid()));

CREATE POLICY "Agent updates own pending advance"
  ON public.business_advances FOR UPDATE
  USING (agent_id = auth.uid() AND status = 'pending');

-- business_advance_repayments policies
CREATE POLICY "Tenant views own repayments"
  ON public.business_advance_repayments FOR SELECT
  USING (tenant_id = auth.uid());

CREATE POLICY "Agent views repayments they recorded"
  ON public.business_advance_repayments FOR SELECT
  USING (agent_id = auth.uid());

CREATE POLICY "Originating agent views all repayments on their advance"
  ON public.business_advance_repayments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.business_advances ba
      WHERE ba.id = advance_id AND ba.agent_id = auth.uid()
    )
  );

CREATE POLICY "Ops staff views all repayments"
  ON public.business_advance_repayments FOR SELECT
  USING (public.is_business_advance_ops(auth.uid()));

CREATE POLICY "Tenant submits own repayment"
  ON public.business_advance_repayments FOR INSERT
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "Agent records collected repayment"
  ON public.business_advance_repayments FOR INSERT
  WITH CHECK (agent_id = auth.uid());

-- daily_accruals policies
CREATE POLICY "Tenant views own accruals"
  ON public.business_advance_daily_accruals FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.business_advances ba WHERE ba.id = advance_id AND ba.tenant_id = auth.uid())
  );

CREATE POLICY "Agent views accruals on own advances"
  ON public.business_advance_daily_accruals FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.business_advances ba WHERE ba.id = advance_id AND ba.agent_id = auth.uid())
  );

CREATE POLICY "Ops staff views all accruals"
  ON public.business_advance_daily_accruals FOR SELECT
  USING (public.is_business_advance_ops(auth.uid()));
