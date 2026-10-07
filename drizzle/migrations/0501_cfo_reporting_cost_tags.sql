CREATE TABLE public.cfo_reporting_cost_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_line text NOT NULL,
  purpose text NOT NULL,
  payment_reference text NOT NULL,
  transaction_group_id uuid NOT NULL,
  expense_ledger_entry_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  original_recipient_id uuid NOT NULL,
  original_recipient_name text NOT NULL,
  requisition_ref text,
  review_flag text,
  applied_by uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) >= 10),
  UNIQUE (business_line, transaction_group_id)
);
COMMENT ON TABLE public.cfo_reporting_cost_tags IS 'Reporting-only links of existing posted payments to a business line. Never moves money or edits ledger entries; each ledger group can be tagged once per business line.';
GRANT SELECT ON public.cfo_reporting_cost_tags TO authenticated;
GRANT ALL ON public.cfo_reporting_cost_tags TO service_role;
ALTER TABLE public.cfo_reporting_cost_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance leadership can read cost tags" ON public.cfo_reporting_cost_tags
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'financial_ops'));
CREATE OR REPLACE FUNCTION public.cfo_reporting_cost_tags_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'cfo_reporting_cost_tags is append-only'; END $$;
CREATE TRIGGER trg_cfo_reporting_cost_tags_immutable BEFORE UPDATE OR DELETE ON public.cfo_reporting_cost_tags
  FOR EACH ROW EXECUTE FUNCTION public.cfo_reporting_cost_tags_immutable();