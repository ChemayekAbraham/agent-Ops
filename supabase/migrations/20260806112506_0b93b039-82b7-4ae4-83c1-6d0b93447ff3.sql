CREATE TABLE public.merchant_float_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_code text NOT NULL UNIQUE DEFAULT ('MFR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  title text NOT NULL,
  requested_amount numeric NOT NULL CHECK (requested_amount > 0),
  reason text NOT NULL,
  coverage_notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','more_info')),
  requested_by uuid,
  requester_name text,
  requester_role text,
  decided_by uuid,
  approver_name text,
  cfo_comment text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.merchant_float_requisitions TO authenticated;
GRANT ALL ON public.merchant_float_requisitions TO service_role;

ALTER TABLE public.merchant_float_requisitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff can view merchant float requisitions"
ON public.merchant_float_requisitions FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'cfo')
  OR public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'ceo')
  OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin')
);

CREATE POLICY "Financial ops can raise merchant float requisitions"
ON public.merchant_float_requisitions FOR INSERT TO authenticated
WITH CHECK (
  requested_by = auth.uid() AND (
    public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'cfo')
  )
);

CREATE POLICY "CFO can decide merchant float requisitions"
ON public.merchant_float_requisitions FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo')
  OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo')
  OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin')
);

CREATE TRIGGER trg_merchant_float_requisitions_updated_at
BEFORE UPDATE ON public.merchant_float_requisitions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();