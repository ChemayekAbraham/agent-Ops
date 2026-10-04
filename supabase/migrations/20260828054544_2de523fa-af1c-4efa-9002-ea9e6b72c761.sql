ALTER TABLE public.merchandise_sales
  DROP CONSTRAINT IF EXISTS merchandise_sales_order_status_check;
ALTER TABLE public.merchandise_sales
  ADD CONSTRAINT merchandise_sales_order_status_check
  CHECK (order_status = ANY (ARRAY[
    'pending_approval','submitted','coo_approved','approved',
    'processing','completed','failed','rejected'
  ]));

ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS coo_approved_by uuid,
  ADD COLUMN IF NOT EXISTS coo_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS cfo_disbursed_by uuid,
  ADD COLUMN IF NOT EXISTS cfo_disbursed_at timestamptz,
  ADD COLUMN IF NOT EXISTS disbursed_amount numeric,
  ADD COLUMN IF NOT EXISTS disbursement_group_id uuid;

CREATE OR REPLACE FUNCTION public.can_coo_approve_smartphone_orders(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'coo')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$$;

CREATE OR REPLACE FUNCTION public.can_cfo_disburse_smartphone_orders(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$$;

CREATE OR REPLACE FUNCTION public.coo_approve_smartphone_order(
  p_sale_id uuid,
  p_total_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL
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

  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved',
      total_amount = v_official,
      total_revenue = v_official,
      unit_price = v_official / GREATEST(COALESCE(quantity, 1), 1),
      payment_projection = v_projection,
      payment_status = 'credit',
      coo_approved_by = v_uid,
      coo_approved_at = now(),
      notes = COALESCE(notes, '') || ' | COO approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at official amount ' || to_char(v_official, 'FM999,999,999')
              || ' - forwarded to CFO for disbursement'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_order_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved smartphone application and forwarded it to the CFO for disbursement',
            jsonb_build_object('total_amount', v_official, 'payment_projection', v_projection));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'coo_approved',
    'total_amount', v_official,
    'payment_projection', v_projection
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(
  p_sale_id uuid,
  p_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_official numeric;
  v_recover numeric;
  v_projection numeric;
  v_customer uuid;
  v_name text;
  v_group uuid;
  v_ref text;
BEGIN
  IF NOT public.can_cfo_disburse_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to disburse smartphone applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Order must be COO approved before disbursement (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;

  v_customer := v_sale.customer_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Order has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  v_official := COALESCE(NULLIF(p_amount, 0), v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_official <= 0 THEN
    RAISE EXCEPTION 'Disbursement amount must be greater than zero';
  END IF;
  v_recover := GREATEST(v_official - COALESCE(v_sale.amount_paid, 0), 0);
  IF v_recover <= 0 THEN
    RAISE EXCEPTION 'Order has no amount to recover';
  END IF;
  v_projection := round(v_official * 0.33);
  v_ref := 'smartphone-disbursement-' || p_sale_id::text;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_customer,
        'amount', v_official,
        'direction', 'cash_in',
        'category', 'agent_float_funding',
        'ledger_scope', 'wallet',
        'recipient_type', 'operational_wallet',
        'wallet_bucket', 'float',
        'source_table', 'merchandise_sales',
        'reference_id', v_ref,
        'currency', 'UGX',
        'description', 'Smartphone access amount released to wallet float',
        'transaction_date', now()
      ),
      jsonb_build_object(
        'user_id', v_uid,
        'amount', v_official,
        'direction', 'cash_out',
        'category', 'equipment_expense',
        'ledger_scope', 'platform',
        'source_table', 'merchandise_sales',
        'reference_id', v_ref,
        'currency', 'UGX',
        'description', 'Smartphone access amount disbursed to ' || COALESCE(v_name, 'agent'),
        'transaction_date', now()
      )
    ),
    v_ref
  );

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      total_amount = v_official,
      total_revenue = v_official,
      unit_price = v_official / GREATEST(COALESCE(quantity, 1), 1),
      payment_projection = v_projection,
      amount_outstanding = v_recover,
      payment_status = 'credit',
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_official,
      disbursement_group_id = v_group,
      notes = COALESCE(notes, '') || ' | CFO disbursed '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' amount ' || to_char(v_official, 'FM999,999,999')
              || ' to wallet float'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      v_sale.item_name, v_recover, v_recover, 0.33, v_uid
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_recover,
        outstanding_balance = GREATEST(v_recover - COALESCE(amount_recovered, 0), 0),
        daily_rate = 0.33
    WHERE sale_id = p_sale_id AND status = 'active';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_order_cfo_disbursed', 'merchandise_sales', p_sale_id,
            'CFO disbursed the smartphone access amount to the agent wallet float and activated the order',
            jsonb_build_object('amount', v_official, 'recovery_amount', v_recover,
                               'transaction_group_id', v_group));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'total_amount', v_official,
    'payment_projection', v_projection,
    'recovery_amount', v_recover,
    'transaction_group_id', v_group
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_smartphone_order(
  p_sale_id uuid,
  p_total_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT COALESCE(order_status, 'submitted') INTO v_status
  FROM public.merchandise_sales WHERE id = p_sale_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_status = 'coo_approved' THEN
    RETURN public.cfo_disburse_smartphone_order(p_sale_id, p_total_amount, p_note);
  END IF;

  RETURN public.coo_approve_smartphone_order(p_sale_id, p_total_amount, p_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_smartphone_order(p_sale_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
BEGIN
  IF NOT public.can_review_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to reject smartphone orders';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters';
  END IF;

  SELECT COALESCE(order_status, 'submitted') INTO v_status
  FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;

  IF v_status = 'coo_approved' AND NOT public.can_cfo_disburse_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Only the CFO can decline an application the COO already approved';
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'rejected',
      amount_outstanding = 0,
      rejection_reason = btrim(p_reason),
      rejected_by = v_uid,
      rejected_at = now()
  WHERE id = p_sale_id
    AND COALESCE(order_status, 'submitted') IN ('pending_approval', 'submitted', 'coo_approved');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or already processed';
  END IF;

  UPDATE public.merchandise_recovery_plans
     SET status = 'cancelled',
         outstanding_balance = 0,
         updated_at = now()
   WHERE sale_id = p_sale_id
     AND status = 'active';

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'rejected');
END;
$$;

DROP FUNCTION IF EXISTS public.list_smartphone_orders(text);
CREATE OR REPLACE FUNCTION public.list_smartphone_orders(p_status text DEFAULT NULL)
RETURNS TABLE(
  id uuid, customer_id uuid, client_name text, client_phone text, brand text,
  model_type text, total_amount numeric, payment_projection numeric,
  amount_outstanding numeric, amount_paid numeric, order_status text,
  rejection_reason text, created_at timestamp with time zone,
  coo_approved_at timestamp with time zone, cfo_disbursed_at timestamp with time zone,
  disbursed_amount numeric
)
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
         s.coo_approved_at, s.cfo_disbursed_at, s.disbursed_amount
  FROM public.merchandise_sales s
  WHERE lower(COALESCE(s.item_name, '')) LIKE '%phone%'
    AND (p_status IS NULL OR COALESCE(s.order_status, 'submitted') = p_status)
  ORDER BY s.created_at DESC
  LIMIT 300;
END;
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.merchandise_sales;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;