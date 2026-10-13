CREATE OR REPLACE FUNCTION public.list_agent_products_in_progress(p_category text)
RETURNS TABLE(id uuid, client_name text, client_phone text, item_name text, quantity int, total_revenue numeric,
  order_status text, created_at timestamptz, ops_approved_at timestamptz, coo_approved_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public._agent_products_authorized() THEN RAISE EXCEPTION 'Not authorized to view agent products'; END IF;
  RETURN QUERY
  SELECT s.id, s.client_name, s.client_phone, s.item_name, s.quantity::int, s.total_revenue::numeric,
         s.order_status, s.created_at, s.ops_approved_at, s.coo_approved_at
  FROM public.merchandise_sales s
  WHERE public.agent_product_category(s.item_name) = lower(p_category)
    AND lower(COALESCE(s.order_status,'')) IN ('pending_approval','submitted','processing','ops_approved','coo_approved')
  ORDER BY s.created_at DESC;
END $$;
REVOKE ALL ON FUNCTION public.list_agent_products_in_progress(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_agent_products_in_progress(text) TO authenticated;