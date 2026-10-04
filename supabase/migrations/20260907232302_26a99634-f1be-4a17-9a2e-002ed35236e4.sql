-- Enable row-level security on financial pricing/subsidy and ledger-reconciliation tables.
-- These tables were created without RLS; this migration locks them down to finance/ops
-- and executive roles, while preserving service-role access for background jobs.

ALTER TABLE public.bd3_pricing_subsidy_population ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_mapped_balance_violations ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bd3_pricing_subsidy_population TO authenticated;
GRANT ALL ON public.bd3_pricing_subsidy_population TO service_role;

GRANT SELECT ON public.ledger_mapped_balance_violations TO authenticated;
GRANT ALL ON public.ledger_mapped_balance_violations TO service_role;

CREATE POLICY "Finance and ops can view pricing subsidy"
ON public.bd3_pricing_subsidy_population
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
);

CREATE POLICY "Finance and ops can modify pricing subsidy"
ON public.bd3_pricing_subsidy_population
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
);

CREATE POLICY "Finance and executives can view ledger violations"
ON public.ledger_mapped_balance_violations
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
);
