CREATE OR REPLACE FUNCTION public.agent_order_merchandise(p_catalog_id uuid, p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_item      record;
  v_total     numeric;
  v_name      text;
  v_phone     text;
  v_sale_id   uuid;
  v_dupe      uuid;
  c_max_qty   constant integer := 20;
  c_max_value constant numeric := 2000000;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF p_quantity > c_max_qty THEN
    RAISE EXCEPTION 'Maximum % units per order. Contact operations for bulk orders.', c_max_qty;
  END IF;

  SELECT * INTO v_item
  FROM public.merchandise_catalog
  WHERE id = p_catalog_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This item is not available';
  END IF;

  v_total := v_item.unit_price * p_quantity;

  IF v_total > c_max_value THEN
    RAISE EXCEPTION 'Order value UGX % exceeds the single-order limit of UGX %.',
      to_char(v_total, 'FM999,999,999'), to_char(c_max_value, 'FM999,999,999');
  END IF;

  -- Duplicate guard: identical order by the same person in the last 5 minutes
  SELECT id INTO v_dupe
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND item_name = v_item.item_name
    AND quantity = p_quantity
    AND created_at > now() - interval '5 minutes'
    AND COALESCE(order_status, 'submitted') NOT IN ('rejected', 'failed')
  LIMIT 1;

  IF v_dupe IS NOT NULL THEN
    RAISE EXCEPTION 'You already placed this exact order moments ago. Check your orders before trying again.';
  END IF;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, 'credit',
    0, v_total, current_date, v_uid, 'Agent self-order via merchandise store'
  ) RETURNING id INTO v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', v_item.item_name,
    'quantity', p_quantity,
    'total', v_total
  );
END;
$function$;