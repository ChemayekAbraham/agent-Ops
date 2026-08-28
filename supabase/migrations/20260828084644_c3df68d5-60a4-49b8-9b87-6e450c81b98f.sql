ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS access_repayment_days integer;

DROP FUNCTION IF EXISTS public.coo_approve_smartphone_order(uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.coo_approve_smartphone_order(
  p_sale_id uuid,
  p_total_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_daily_deduction numeric DEFAULT NULL,
  p_repayment_days integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_official numeric;
  v_projection numeric;
  v_daily numeric;
  v_days integer;
BEGIN
  IF NOT public.can_coo_approve_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve smartphone applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') NOT IN ('pending_approval','submitted') THEN
    RAISE EXCEPTION 'Order is already %', v_sale.order_status;
  END IF;
  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'Order has no linked agent account';
  END IF;

  v_official := COALESCE(NULLIF(p_total_amount, 0), v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_official <= 0 THEN
    RAISE EXCEPTION 'Official phone amount must be greater than zero';
  END IF;
  v_projection := round(v_official * 0.33);

  v_days := NULLIF(GREATEST(COALESCE(p_repayment_days, 0), 0), 0);
  v_daily := NULLIF(GREATEST(COALESCE(round(p_daily_deduction), 0), 0), 0);

  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved',
      total_amount = v_official,
      total_revenue = v_official,
      unit_price = v_official / GREATEST(COALESCE(quantity, 1), 1),
      payment_projection = v_projection,
      payment_status = 'credit',
      access_daily_amount = COALESCE(v_daily, access_daily_amount),
      access_repayment_days = COALESCE(v_days, access_repayment_days),
      coo_approved_by = v_uid,
      coo_approved_at = now(),
      notes = COALESCE(notes, '') || ' | COO approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at official amount ' || to_char(v_official, 'FM999,999,999')
              || COALESCE(' - daily deduction ' || to_char(v_daily, 'FM999,999,999'), '')
              || COALESCE(' over ' || v_days::text || ' days', '')
              || ' - forwarded to CFO for disbursement'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_order_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved smartphone application and forwarded it to the CFO for disbursement',
            jsonb_build_object('total_amount', v_official, 'payment_projection', v_projection,
                               'access_daily_amount', v_daily, 'access_repayment_days', v_days));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'coo_approved',
    'total_amount', v_official,
    'payment_projection', v_projection,
    'access_daily_amount', v_daily,
    'access_repayment_days', v_days
  );
END;
$$;

DROP FUNCTION IF EXISTS public.list_smartphone_orders(text);

CREATE OR REPLACE FUNCTION public.list_smartphone_orders(p_status text DEFAULT NULL::text)
RETURNS TABLE(id uuid, customer_id uuid, client_name text, client_phone text, brand text,
  model_type text, total_amount numeric, payment_projection numeric, amount_outstanding numeric,
  amount_paid numeric, order_status text, rejection_reason text, created_at timestamp with time zone,
  coo_approved_at timestamp with time zone, cfo_disbursed_at timestamp with time zone,
  disbursed_amount numeric, access_daily_amount numeric, access_repayment_days integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view smartphone orders';
  END IF;

  RETURN QUERY
  SELECT s.id, s.customer_id, s.client_name, s.client_phone, s.brand, s.model_type,
         COALESCE(
           NULLIF(s.total_amount, 0),
           NULLIF(s.total_revenue, 0),
           NULLIF(s.unit_price * GREATEST(COALESCE(s.quantity, 1), 1), 0),
           0
         ) AS total_amount,
         COALESCE(
           NULLIF(s.payment_projection, 0),
           ROUND(
             COALESCE(
               NULLIF(s.total_amount, 0),
               NULLIF(s.total_revenue, 0),
               NULLIF(s.unit_price * GREATEST(COALESCE(s.quantity, 1), 1), 0),
               0
             ) * 0.33
           )
         ) AS payment_projection,
         s.amount_outstanding, s.amount_paid,
         COALESCE(s.order_status, 'submitted') AS order_status,
         s.rejection_reason, s.created_at,
         s.coo_approved_at, s.cfo_disbursed_at, s.disbursed_amount,
         s.access_daily_amount, s.access_repayment_days
  FROM public.merchandise_sales s
  WHERE lower(COALESCE(s.item_name, '')) LIKE '%phone%'
    AND (p_status IS NULL OR COALESCE(s.order_status, 'submitted') = p_status)
  ORDER BY s.created_at DESC
  LIMIT 300;
END;
$$;