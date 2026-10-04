
-- Disbursement Records: tracks every payout after CFO approval
CREATE TABLE public.disbursement_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  landlord_id UUID,
  agent_id UUID,
  amount NUMERIC NOT NULL,
  payout_method TEXT NOT NULL DEFAULT 'wallet',
  transaction_reference TEXT,
  disbursed_by UUID,
  disbursed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  landlord_confirmed BOOLEAN DEFAULT false,
  landlord_confirmed_at TIMESTAMPTZ,
  agent_confirmed BOOLEAN DEFAULT false,
  agent_confirmed_at TIMESTAMPTZ,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent Delivery Confirmations: agent confirms receipt collection with proof
CREATE TABLE public.agent_delivery_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disbursement_id UUID REFERENCES public.disbursement_records(id) NOT NULL,
  agent_id UUID NOT NULL,
  rent_request_id UUID NOT NULL,
  confirmation_type TEXT NOT NULL DEFAULT 'receipt_collected',
  photo_urls TEXT[] DEFAULT '{}',
  latitude NUMERIC,
  longitude NUMERIC,
  location_accuracy NUMERIC,
  landlord_signature_url TEXT,
  notes TEXT,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CFO Threshold Alerts: auto-generated alerts for financial thresholds
CREATE TABLE public.cfo_threshold_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  title TEXT NOT NULL,
  description TEXT,
  threshold_value NUMERIC,
  current_value NUMERIC,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.disbursement_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_delivery_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cfo_threshold_alerts ENABLE ROW LEVEL SECURITY;

-- Managers/executives can read all disbursements
CREATE POLICY "Managers can view disbursements" ON public.disbursement_records
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can insert disbursements" ON public.disbursement_records
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can update disbursements" ON public.disbursement_records
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

-- Agents can view their own delivery confirmations
CREATE POLICY "Agents view own confirmations" ON public.agent_delivery_confirmations
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Agents insert confirmations" ON public.agent_delivery_confirmations
  FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());

-- Managers can view/manage alerts
CREATE POLICY "Managers view alerts" ON public.cfo_threshold_alerts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers update alerts" ON public.cfo_threshold_alerts
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "System inserts alerts" ON public.cfo_threshold_alerts
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Index for fast lookups
CREATE INDEX idx_disbursement_rent_request ON public.disbursement_records(rent_request_id);
CREATE INDEX idx_disbursement_date ON public.disbursement_records(disbursed_at DESC);
CREATE INDEX idx_delivery_conf_disbursement ON public.agent_delivery_confirmations(disbursement_id);
CREATE INDEX idx_cfo_alerts_unacked ON public.cfo_threshold_alerts(acknowledged, created_at DESC);
