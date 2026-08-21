-- 1. Submission: no balance gate, pending approval, no recovery plan yet
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

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes,
    brand, model_type, total_amount, payment_projection, order_status
  ) VALUES (
    'Welile Smartphone', 1, p_total_amount, 0, p_total_amount,
    v_name, v_phone, v_uid, 'credit',
    0, 0, current_date, v_uid,
    'Agent smartphone order — pending approval. Total ' || p_total_amount::text
      || ' UGX, 33% recovery projection ' || v_projection::text || ' UGX',
    p_brand, p_model_type, p_total_amount, v_projection, 'pending_approval'
  ) RETURNING id INTO v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', 'Welile Smartphone',
    'brand', p_brand,
    'model_type', p_model_type,
    'total', p_total_amount,
    'payment_projection', v_projection,
    'order_status', 'pending_approval'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_order_smartphone(numeric, text, text) TO authenticated;

-- 2. Role helper for smartphone order review
CREATE OR REPLACE FUNCTION public.can_review_smartphone_orders(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
      OR public.has_role(_user_id, 'cmo')
      OR public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'coo')
      OR public.has_role(_user_id, 'agent_ops')
$$;

-- 3. Listing for the Agent Smart Phones page
CREATE OR REPLACE FUNCTION public.list_smartphone_orders(p_status text DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  customer_id uuid,
  client_name text,
  client_phone text,
  brand text,
  model_type text,
  total_amount numeric,
  payment_projection numeric,
  amount_outstanding numeric,
  amount_paid numeric,
  order_status text,
  rejection_reason text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view smartphone orders';
  END IF;

  RETURN QUERY
  SELECT s.id, s.customer_id, s.client_name, s.client_phone, s.brand, s.model_type,
         COALESCE(s.total_amount, s.total_revenue) AS total_amount,
         COALESCE(s.payment_projection, ROUND(COALESCE(s.total_amount, s.total_revenue) * 0.33)) AS payment_projection,
         s.amount_outstanding, s.amount_paid,
         COALESCE(s.order_status, 'submitted') AS order_status,
         s.rejection_reason, s.created_at
  FROM public.merchandise_sales s
  WHERE lower(COALESCE(s.item_name, '')) LIKE '%phone%'
    AND (p_status IS NULL OR COALESCE(s.order_status, 'submitted') = p_status)
  ORDER BY s.created_at DESC
  LIMIT 300;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_smartphone_orders(text) TO authenticated;

-- 4. Approve: starts the 33% wallet recovery plan
CREATE OR REPLACE FUNCTION public.approve_smartphone_order(p_sale_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_amount numeric;
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

  v_amount := GREATEST(COALESCE(v_sale.total_amount, v_sale.total_revenue, 0) - COALESCE(v_sale.amount_paid, 0), 0);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Order has no amount to recover';
  END IF;

  v_customer := v_sale.customer_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Order has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      amount_outstanding = v_amount,
      payment_status = 'credit',
      notes = COALESCE(notes, '') || ' | Approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
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
  END IF;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'approved', 'recovery_amount', v_amount);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.approve_smartphone_order(uuid, text) TO authenticated;

-- 5. Reject
CREATE OR REPLACE FUNCTION public.reject_smartphone_order(p_sale_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.can_review_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to reject smartphone orders';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters';
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'rejected',
      amount_outstanding = 0,
      rejection_reason = btrim(p_reason),
      rejected_by = v_uid,
      rejected_at = now()
  WHERE id = p_sale_id
    AND COALESCE(order_status, 'submitted') IN ('pending_approval', 'submitted');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or already processed';
  END IF;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'rejected');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reject_smartphone_order(uuid, text) TO authenticated;