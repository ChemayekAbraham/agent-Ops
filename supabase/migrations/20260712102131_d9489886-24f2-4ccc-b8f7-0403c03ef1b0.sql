CREATE OR REPLACE FUNCTION public.agent_order_smartphone(p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_name    text;
  v_phone   text;
  v_sale_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_amount IS NULL OR p_amount < 1000 THEN
    RAISE EXCEPTION 'Enter an amount of at least UGX 1,000';
  END IF;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes
  ) VALUES (
    'Welile Smartphone', 1, p_amount, 0, p_amount,
    v_name, v_phone, v_uid, 'credit',
    0, p_amount, current_date, v_uid,
    'Agent smartphone order via merchandise store (agent-chosen wallet deduction; final price set by marketing)'
  ) RETURNING id INTO v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', 'Welile Smartphone',
    'total', p_amount
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_order_smartphone(numeric) TO authenticated;