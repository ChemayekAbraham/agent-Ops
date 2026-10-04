
CREATE TABLE public.pre_registered_tids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id text NOT NULL,
  amount numeric NOT NULL,
  provider text DEFAULT 'mtn',
  registered_by uuid NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'waiting',
  matched_deposit_id uuid REFERENCES public.deposit_requests(id),
  matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pre_registered_tids_tid ON public.pre_registered_tids(transaction_id);
CREATE INDEX idx_pre_registered_tids_status ON public.pre_registered_tids(status);

ALTER TABLE public.pre_registered_tids ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage pre_registered_tids"
ON public.pre_registered_tids
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'coo') OR
  public.has_role(auth.uid(), 'operations')
)
WITH CHECK (
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'coo') OR
  public.has_role(auth.uid(), 'operations')
);
