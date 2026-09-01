CREATE OR REPLACE FUNCTION public.agent_ops_approve_merchandise_order(p_sale_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status text;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to approve agent product applications';
  END IF;

  SELECT lower(COALESCE(order_status,'')) INTO v_status
  FROM public.merchandise_sales WHERE id = p_sale_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;

  IF v_status IN ('rejected','cancelled','declined') THEN
    RAISE EXCEPTION 'Application is already closed';
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'issued',
      ops_approved_by = auth.uid(),
      ops_approved_at = now(),
      updated_at = now()
  WHERE id = p_sale_id;

  RETURN p_sale_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.agent_ops_approve_merchandise_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_approve_merchandise_order(uuid) TO authenticated;