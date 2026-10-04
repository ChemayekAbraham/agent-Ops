
-- Add auto_reinvest flag and maturity_alert_sent to investor_portfolios
ALTER TABLE public.investor_portfolios 
  ADD COLUMN IF NOT EXISTS auto_reinvest boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maturity_alert_30d boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maturity_alert_7d boolean NOT NULL DEFAULT false;

-- Create partner_escalations table for tracking stale approvals and alerts
CREATE TABLE IF NOT EXISTS public.partner_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid REFERENCES public.investor_portfolios(id) ON DELETE CASCADE NOT NULL,
  escalation_type text NOT NULL, -- 'stale_approval', 'maturity_30d', 'maturity_7d', 'maturity_expired'
  status text NOT NULL DEFAULT 'open', -- 'open', 'acknowledged', 'resolved'
  details jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);

ALTER TABLE public.partner_escalations ENABLE ROW LEVEL SECURITY;

-- Allow managers/coo to read and update escalations
CREATE POLICY "Managers can manage escalations"
  ON public.partner_escalations
  FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'coo')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'coo')
  );
