CREATE OR REPLACE FUNCTION public.get_agent_products_services_report(p_date date DEFAULT NULL, p_from date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_src text;
  v_day date;
BEGIN
  -- placeholder body replaced below
  RETURN NULL;
END;
$fn$;