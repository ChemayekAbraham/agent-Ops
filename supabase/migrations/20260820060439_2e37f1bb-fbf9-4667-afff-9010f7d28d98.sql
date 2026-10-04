CREATE TABLE public.service_centre_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  assigned_agent_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  stationed_location text NOT NULL,
  unit_price numeric NOT NULL DEFAULT 0,
  forecast_amount numeric NOT NULL DEFAULT 0,
  payment_mode text NOT NULL DEFAULT 'installments',
  paid_upfront numeric NOT NULL DEFAULT 0,
  duration_value integer NOT NULL DEFAULT 1,
  duration_unit text NOT NULL DEFAULT 'months',
  status text NOT NULL DEFAULT 'pending_coo',
  notes text,
  created_by uuid,
  coo_approved_by uuid,
  coo_approved_at timestamp with time zone,
  ceo_approved_by uuid,
  ceo_approved_at timestamp with time zone,
  verified_by uuid,
  verified_at timestamp with time zone,
  rejection_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT service_centre_entries_max_agents CHECK (array_length(assigned_agent_ids, 1) IS NULL OR array_length(assigned_agent_ids, 1) <= 5),
  CONSTRAINT service_centre_entries_payment_mode_check CHECK (payment_mode IN ('installments', 'full_payment')),
  CONSTRAINT service_centre_entries_duration_unit_check CHECK (duration_unit IN ('days', 'months', 'years')),
  CONSTRAINT service_centre_entries_status_check CHECK (status IN ('pending_coo', 'pending_ceo', 'verified', 'rejected'))
);

GRANT SELECT, INSERT, UPDATE ON public.service_centre_entries TO authenticated;
GRANT ALL ON public.service_centre_entries TO service_role;

ALTER TABLE public.service_centre_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops leadership can view service centre entries"
ON public.service_centre_entries
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Ops leadership can create service centre entries"
ON public.service_centre_entries
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Ops leadership can advance service centre entries"
ON public.service_centre_entries
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE TRIGGER update_service_centre_entries_updated_at
BEFORE UPDATE ON public.service_centre_entries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();