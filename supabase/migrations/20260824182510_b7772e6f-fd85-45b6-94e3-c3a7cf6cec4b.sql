DROP FUNCTION IF EXISTS public.approve_smartphone_order(uuid, text);

CREATE OR REPLACE FUNCTION public.approve_smartphone_order(
  p_sale_id uuid,
  p_total_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_official numeric;
  v_amount numeric;
  v_projection numeric;
  v_customer uuid;
  v_name text;
BEGIN
  IF NOT public.can_review_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve smartphone orders';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') NOT IN ('pending_approval', 'submitted') THEN
    RAISE EXCEPTION 'Order is already %', v_sale.order_status;
  END IF;

  v_official := COALESCE(NULLIF(p_total_amount, 0), v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_official <= 0 THEN
    RAISE EXCEPTION 'Official phone amount must be greater than zero';
  END IF;

  v_amount := GREATEST(v_official - COALESCE(v_sale.amount_paid, 0), 0);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Order has no amount to recover';
  END IF;
  v_projection := round(v_official * 0.33);

  v_customer := v_sale.customer_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Order has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      total_amount = v_official,
      total_revenue = v_official,
      unit_price = v_official / GREATEST(COALESCE(quantity, 1), 1),
      payment_projection = v_projection,
      amount_outstanding = v_amount,
      payment_status = 'credit',
      notes = COALESCE(notes, '') || ' | Approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at official amount ' || to_char(v_official, 'FM999,999,999')
              || COALESCE(' — ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      v_sale.item_name, v_amount, v_amount, 0.33, v_uid
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_amount,
        outstanding_balance = GREATEST(v_amount - COALESCE(amount_recovered, 0), 0),
        daily_rate = 0.33
    WHERE sale_id = p_sale_id AND status = 'active';
  END IF;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'total_amount', v_official,
    'payment_projection', v_projection,
    'recovery_amount', v_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_smartphone_order(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_smartphone_order(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_smartphone_order(uuid, numeric, text) TO service_role;