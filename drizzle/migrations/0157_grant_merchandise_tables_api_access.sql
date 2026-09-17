-- The merchandise tables have RLS policies but no table-level GRANTs, so the
-- Data API cannot read them at all: the store showed "No merchandise available".
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_catalog TO authenticated;
GRANT ALL ON public.merchandise_catalog TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_recovery_plans TO authenticated;
GRANT ALL ON public.merchandise_recovery_plans TO service_role;

GRANT SELECT ON public.merchandise_recovery_deductions TO authenticated;
GRANT ALL ON public.merchandise_recovery_deductions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_sales TO authenticated;
GRANT ALL ON public.merchandise_sales TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_purchases TO authenticated;
GRANT ALL ON public.merchandise_purchases TO service_role;

GRANT SELECT ON public.merchandise_share_codes TO anon;
GRANT SELECT ON public.merchandise_share_codes TO authenticated;
GRANT ALL ON public.merchandise_share_codes TO service_role;

GRANT SELECT ON public.merchandise_share_opens TO authenticated;
GRANT ALL ON public.merchandise_share_opens TO service_role;