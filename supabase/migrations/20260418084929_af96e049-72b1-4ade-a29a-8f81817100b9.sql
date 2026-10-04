CREATE TABLE public.public_rent_history_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  submitter_name text NOT NULL,
  submitter_phone text NOT NULL,
  landlord_name text NOT NULL,
  landlord_phone text NOT NULL,
  property_location text NOT NULL,
  month_key text NOT NULL,
  rent_amount numeric NOT NULL CHECK (rent_amount > 0),
  status text NOT NULL DEFAULT 'pending',
  linked_tenant_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_prhs_agent ON public.public_rent_history_submissions(agent_id, created_at DESC);
CREATE INDEX idx_prhs_status ON public.public_rent_history_submissions(status, created_at DESC);
CREATE INDEX idx_prhs_phone ON public.public_rent_history_submissions(submitter_phone);

ALTER TABLE public.public_rent_history_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anyone can submit rent history"
ON public.public_rent_history_submissions
FOR INSERT
TO anon, authenticated
WITH CHECK (
  agent_id IS NOT NULL
  AND length(submitter_name) > 0
  AND length(submitter_phone) > 0
  AND length(landlord_name) > 0
  AND length(landlord_phone) > 0
  AND length(property_location) > 0
  AND length(month_key) = 7
);

CREATE POLICY "agent can read own referral submissions"
ON public.public_rent_history_submissions
FOR SELECT
TO authenticated
USING (auth.uid() = agent_id);

CREATE POLICY "staff can read all rent history submissions"
ON public.public_rent_history_submissions
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'operations')
);

CREATE POLICY "staff can update rent history submissions"
ON public.public_rent_history_submissions
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'operations')
);

CREATE TRIGGER trg_prhs_updated_at
BEFORE UPDATE ON public.public_rent_history_submissions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();