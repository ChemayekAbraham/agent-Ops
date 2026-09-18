-- When a merchandise sale (application) is deleted, remove its recovery plan and
-- that plan's deduction history instead of orphaning them with sale_id = NULL.
CREATE OR REPLACE FUNCTION public.merchandise_sale_cascade_recovery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.merchandise_recovery_deductions d
   WHERE d.plan_id IN (
     SELECT p.id FROM public.merchandise_recovery_plans p WHERE p.sale_id = OLD.id
   );

  DELETE FROM public.merchandise_recovery_plans p
   WHERE p.sale_id = OLD.id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_merchandise_sale_cascade_recovery ON public.merchandise_sales;

CREATE TRIGGER trg_merchandise_sale_cascade_recovery
BEFORE DELETE ON public.merchandise_sales
FOR EACH ROW
EXECUTE FUNCTION public.merchandise_sale_cascade_recovery();