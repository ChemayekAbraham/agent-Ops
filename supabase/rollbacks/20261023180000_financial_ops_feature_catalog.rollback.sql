-- Removes the feature catalog and puts the two-area check back (only if no other feature is in use).
UPDATE public.financial_ops_restrictions SET lifted_at = now() WHERE area NOT IN ('float', 'email_transactions') AND lifted_at IS NULL;
ALTER TABLE public.financial_ops_restrictions ADD CONSTRAINT financial_ops_restrictions_area_check CHECK (area IN ('float', 'email_transactions'));
DROP FUNCTION IF EXISTS public.list_financial_ops_features();
DROP TABLE IF EXISTS public.financial_ops_features;
-- set_financial_ops_restriction: re-run the version in 20261023170000 to restore its two-area check.
