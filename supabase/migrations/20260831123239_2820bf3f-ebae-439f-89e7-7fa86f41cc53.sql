CREATE OR REPLACE FUNCTION public.assign_smartphone_order_supplier(p_sale_id uuid, p_supplier_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.merchandise_sales;
  v_name text;
BEGIN
  IF NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to assign a supplier to smartphone applications';
  END IF;

  SELECT * INTO v_row FROM public.merchandise_sales WHERE id = p_sale_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF lower(COALESCE(v_row.item_name, '')) NOT LIKE '%phone%' THEN
    RAISE EXCEPTION 'This record is not a smartphone application';
  END IF;

  IF p_supplier_id IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE id = p_supplier_id;
    IF v_name IS NULL AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_supplier_id) THEN
      RAISE EXCEPTION 'Supplier must be a registered platform user';
    END IF;
  END IF;

  UPDATE public.merchandise_sales
     SET supplier_id = p_supplier_id,
         updated_at = now()
   WHERE id = p_sale_id;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'supplier_id', p_supplier_id, 'supplier_name', v_name);
END;
$$;

REVOKE ALL ON FUNCTION public.assign_smartphone_order_supplier(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_smartphone_order_supplier(uuid, uuid) TO authenticated;