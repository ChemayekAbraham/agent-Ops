CREATE TABLE public.merchant_balance_disputes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL DEFAULT auth.uid(),
  desk_id uuid REFERENCES public.cashout_agents(id) ON DELETE SET NULL,
  disputed_field text NOT NULL DEFAULT 'owed_to_agent' CHECK (disputed_field = ANY (ARRAY['owed_to_agent','company_cash_with_agent','paid_out','out_of_pocket','float_available'])),
  system_amount numeric NOT NULL DEFAULT 0,
  claimed_amount numeric,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 15),
  status text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open','reviewing','resolved','rejected'])),
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_mbd_status ON public.merchant_balance_disputes(status, created_at DESC);
CREATE INDEX idx_mbd_agent ON public.merchant_balance_disputes(agent_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.merchant_balance_disputes TO authenticated;
GRANT ALL ON public.merchant_balance_disputes TO service_role;

ALTER TABLE public.merchant_balance_disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents raise their own balance disputes"
ON public.merchant_balance_disputes FOR INSERT TO authenticated
WITH CHECK (agent_id = auth.uid() AND status = 'open');

CREATE POLICY "View own or finance views all balance disputes"
ON public.merchant_balance_disputes FOR SELECT TO authenticated
USING (
  agent_id = auth.uid()
  OR has_role(auth.uid(), 'financial_ops'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
);

CREATE POLICY "Finance resolves balance disputes"
ON public.merchant_balance_disputes FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'financial_ops'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
)
WITH CHECK (
  has_role(auth.uid(), 'financial_ops'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE TRIGGER trg_mbd_touch
BEFORE UPDATE ON public.merchant_balance_disputes
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();