ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS model_type text,
  ADD COLUMN IF NOT EXISTS total_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_projection numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.agent_order_smartphone(
  p_total_amount numeric,
  p_brand text,
  p_model_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_name      text;
  v_phone     text;
  v_sale_id   uuid;
  v_available numeric;
  v_projection numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF COALESCE(p_brand, '') = '' THEN
    RAISE EXCEPTION 'Select a product brand';
  END IF;
  IF COALESCE(p_model_type, '') = '' THEN
    RAISE EXCEPTION 'Enter the type of phone';
  END IF;
  IF p_total_amount IS NULL OR p_total_amount < 1000 THEN
    RAISE EXCEPTION 'Enter a phone amount of at least UGX 1,000';
  END IF;

  v_projection := ROUND(p_total_amount * 0.33);
  v_available := public.get_user_available_balance(v_uid);
  IF v_projection > v_available THEN
    RAISE EXCEPTION 'Payment projection of UGX % exceeds your available wallet balance of UGX %.',
      to_char(v_projection, 'FM999,999,999,990'),
      to_char(v_available, 'FM999,999,999,990');
  END IF;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes,
    brand, model_type, total_amount, payment_projection
  ) VALUES (
    'Welile Smartphone', 1, p_total_amount, 0, p_total_amount,
    v_name, v_phone, v_uid, 'credit',
    0, p_total_amount, current_date, v_uid,
    'Agent smartphone order via merchandise store — total ' || p_total_amount::text || ' UGX, 33% recovery projection ' || v_projection::text || ' UGX',
    p_brand, p_model_type, p_total_amount, v_projection
  ) RETURNING id INTO v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', 'Welile Smartphone',
    'brand', p_brand,
    'model_type', p_model_type,
    'total', p_total_amount,
    'payment_projection', v_projection
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_order_smartphone(numeric, text, text) TO authenticated;