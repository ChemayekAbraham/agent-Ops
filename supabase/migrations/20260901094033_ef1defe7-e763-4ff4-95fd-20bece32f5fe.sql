CREATE OR REPLACE FUNCTION public.merchandise_sync_completion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF lower(COALESCE(NEW.order_status,'')) = 'issued'
     AND COALESCE(NEW.amount_outstanding, 0) <= 0 THEN
    NEW.order_status := 'completed';
  ELSIF lower(COALESCE(NEW.order_status,'')) = 'completed'
     AND COALESCE(NEW.amount_outstanding, 0) > 0 THEN
    NEW.order_status := 'issued';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_merchandise_sync_completion ON public.merchandise_sales;
CREATE TRIGGER trg_merchandise_sync_completion
BEFORE INSERT OR UPDATE OF order_status, amount_outstanding, amount_paid
ON public.merchandise_sales
FOR EACH ROW
EXECUTE FUNCTION public.merchandise_sync_completion();

UPDATE public.merchandise_sales
SET order_status = 'completed', updated_at = now()
WHERE lower(COALESCE(order_status,'')) = 'issued'
  AND COALESCE(amount_outstanding, 0) <= 0;

DO $do$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'get_agent_products_overview' LIMIT 1;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'get_agent_products_overview not found';
  END IF;
  v_src := replace(
    v_src,
    'ARRAY[''issued''] ELSE NULL END',
    'ARRAY[''issued'',''completed''] ELSE NULL END'
  );
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_agent_products_overview(p_category text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS %L',
    v_src
  );
END
$do$;