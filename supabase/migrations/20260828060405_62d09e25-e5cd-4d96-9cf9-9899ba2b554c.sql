ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS lease_term_months integer,
  ADD COLUMN IF NOT EXISTS lease_daily_rate numeric,
  ADD COLUMN IF NOT EXISTS lease_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS valuation_amount numeric;

CREATE OR REPLACE FUNCTION public.can_review_bike_leases(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'coo')
      OR public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'agent_ops')
      OR public.has_role(_user_id, 'operations')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$$;

CREATE OR REPLACE FUNCTION public.can_coo_approve_bike_leases(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'coo')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$$;

CREATE OR REPLACE FUNCTION public.can_cfo_disburse_bike_leases(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$$;

-- Agent submits a Spiro electric bike lease application
CREATE OR REPLACE FUNCTION public.agent_order_spiro_bike_lease(
  p_model text,
  p_valuation numeric,
  p_lease_term_months integer DEFAULT 12,
  p_daily_rate numeric DEFAULT 0.15,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_phone text;
  v_sale_id uuid;
  v_tracking text;
  v_model text := NULLIF(btrim(COALESCE(p_model, '')), '');
  v_term integer := GREATEST(COALESCE(p_lease_term_months, 12), 1);
  v_rate numeric := LEAST(GREATEST(COALESCE(p_daily_rate, 0.15), 0.01), 1);
  v_projection numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_model IS NULL THEN
    RAISE EXCEPTION 'Select a Spiro bike model';
  END IF;
  IF p_valuation IS NULL OR p_valuation < 100000 THEN
    RAISE EXCEPTION 'Bike valuation must be at least UGX 100,000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.merchandise_sales
    WHERE customer_id = v_uid
      AND lower(COALESCE(item_name, '')) LIKE '%spiro%'
      AND COALESCE(order_status, 'submitted') IN ('submitted','pending_approval','coo_approved')
  ) THEN
    RAISE EXCEPTION 'You already have a Spiro bike application in review';
  END IF;

  SELECT full_name, phone INTO v_name, v_phone FROM public.profiles WHERE id = v_uid;

  v_tracking := 'SPB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_projection := round(p_valuation * v_rate);

  INSERT INTO public.merchandise_sales (
    item_name, brand, model_type, quantity, unit_price, unit_cost, total_revenue, total_amount,
    valuation_amount, payment_projection, lease_term_months, lease_daily_rate,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, order_status, notes, tracking_reference
  ) VALUES (
    'Welile Spiro Bike', 'Spiro', v_model, 1, p_valuation, 0, p_valuation, p_valuation,
    p_valuation, v_projection, v_term, v_rate,
    v_name, v_phone, v_uid, 'credit',
    0, p_valuation, current_date, v_uid, 'submitted',
    'Spiro electric bike lease application - model ' || v_model
      || ', valuation ' || to_char(p_valuation, 'FM999,999,999')
      || ', lease term ' || v_term || ' months, wallet recovery rate '
      || to_char(v_rate * 100, 'FM990.9') || '% per credit'
      || COALESCE(' - ' || NULLIF(btrim(p_note), ''), ''),
    v_tracking
  ) RETURNING id INTO v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'model', v_model,
    'valuation', p_valuation,
    'lease_term_months', v_term,
    'daily_recovery', v_projection,
    'order_status', 'submitted',
    'tracking_reference', v_tracking
  );
END;
$$;

-- Stage 1: COO approves valuation + lease terms, forwards to CFO. No money moves.
CREATE OR REPLACE FUNCTION public.coo_approve_bike_lease(
  p_sale_id uuid,
  p_valuation numeric DEFAULT NULL,
  p_lease_term_months integer DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_term integer;
  v_rate numeric;
  v_projection numeric;
BEGIN
  IF NOT public.can_coo_approve_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve Spiro bike lease applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') NOT IN ('submitted','pending_approval') THEN
    RAISE EXCEPTION 'Application is already %', COALESCE(v_sale.order_status, 'submitted');
  END IF;
  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;

  v_valuation := COALESCE(NULLIF(p_valuation, 0), v_sale.valuation_amount, v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Approved bike valuation must be greater than zero';
  END IF;
  v_term := GREATEST(COALESCE(NULLIF(p_lease_term_months, 0), v_sale.lease_term_months, 12), 1);
  v_rate := LEAST(GREATEST(COALESCE(v_sale.lease_daily_rate, 0.15), 0.01), 1);
  v_projection := round(v_valuation * v_rate);

  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved',
      valuation_amount = v_valuation,
      total_amount = v_valuation,
      total_revenue = v_valuation,
      unit_price = v_valuation / GREATEST(COALESCE(quantity, 1), 1),
      lease_term_months = v_term,
      lease_daily_rate = v_rate,
      payment_projection = v_projection,
      payment_status = 'credit',
      coo_approved_by = v_uid,
      coo_approved_at = now(),
      notes = COALESCE(notes, '') || ' | COO approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at valuation ' || to_char(v_valuation, 'FM999,999,999')
              || ' over ' || v_term || ' months - forwarded to CFO for bike release'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved the Spiro bike lease valuation and forwarded it to the CFO for release',
            jsonb_build_object('valuation', v_valuation, 'lease_term_months', v_term,
                               'daily_recovery', v_projection));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'coo_approved',
    'valuation', v_valuation,
    'lease_term_months', v_term,
    'daily_recovery', v_projection
  );
END;
$$;

-- Stage 2: CFO releases the bike and activates the lease (creates the recovery plan).
CREATE OR REPLACE FUNCTION public.cfo_disburse_bike_lease(
  p_sale_id uuid,
  p_valuation numeric DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_recover numeric;
  v_rate numeric;
  v_term integer;
  v_customer uuid;
  v_name text;
BEGIN
  IF NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to release Spiro bikes';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved before release (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;

  v_customer := v_sale.customer_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  v_valuation := COALESCE(NULLIF(p_valuation, 0), v_sale.valuation_amount, v_sale.total_amount, v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Bike valuation must be greater than zero';
  END IF;
  v_recover := GREATEST(v_valuation - COALESCE(v_sale.amount_paid, 0), 0);
  IF v_recover <= 0 THEN
    RAISE EXCEPTION 'Lease has no amount to recover';
  END IF;
  v_rate := LEAST(GREATEST(COALESCE(v_sale.lease_daily_rate, 0.15), 0.01), 1);
  v_term := GREATEST(COALESCE(v_sale.lease_term_months, 12), 1);

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      valuation_amount = v_valuation,
      total_amount = v_valuation,
      total_revenue = v_valuation,
      unit_price = v_valuation / GREATEST(COALESCE(quantity, 1), 1),
      amount_outstanding = v_recover,
      payment_projection = round(v_valuation * v_rate),
      payment_status = 'credit',
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_valuation,
      lease_activated_at = now(),
      notes = COALESCE(notes, '') || ' | CFO released the bike and activated the lease '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at valuation ' || to_char(v_valuation, 'FM999,999,999')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      COALESCE(v_sale.item_name, 'Welile Spiro Bike'), v_recover, v_recover, v_rate, v_uid
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_recover,
        outstanding_balance = GREATEST(v_recover - COALESCE(amount_recovered, 0), 0),
        daily_rate = v_rate
    WHERE sale_id = p_sale_id AND status = 'active';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_cfo_disbursed', 'merchandise_sales', p_sale_id,
            'CFO released the Spiro electric bike and activated the wallet recovery lease',
            jsonb_build_object('valuation', v_valuation, 'recovery_amount', v_recover,
                               'daily_rate', v_rate, 'lease_term_months', v_term));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'valuation', v_valuation,
    'recovery_amount', v_recover,
    'daily_rate', v_rate,
    'lease_term_months', v_term
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_bike_lease(p_sale_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
BEGIN
  IF NOT public.can_review_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to reject Spiro bike lease applications';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters';
  END IF;

  SELECT COALESCE(order_status, 'submitted') INTO v_status
  FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF v_status NOT IN ('submitted','pending_approval','coo_approved') THEN
    RAISE EXCEPTION 'Application is already %', v_status;
  END IF;
  IF v_status = 'coo_approved' AND NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Only the CFO can reject an application already approved by the COO';
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'rejected',
      rejection_reason = btrim(p_reason),
      notes = COALESCE(notes, '') || ' | Rejected ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' - ' || btrim(p_reason)
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
    VALUES (v_uid, 'bike_lease_rejected', 'merchandise_sales', p_sale_id, btrim(p_reason));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'rejected');
END;
$$;

DROP FUNCTION IF EXISTS public.list_bike_lease_orders(text);
CREATE OR REPLACE FUNCTION public.list_bike_lease_orders(p_status text DEFAULT NULL)
RETURNS TABLE(
  id uuid, customer_id uuid, client_name text, client_phone text,
  model_type text, valuation_amount numeric, payment_projection numeric,
  lease_term_months integer, lease_daily_rate numeric,
  amount_outstanding numeric, amount_paid numeric, order_status text,
  rejection_reason text, created_at timestamptz,
  coo_approved_at timestamptz, cfo_disbursed_at timestamptz,
  lease_activated_at timestamptz, disbursed_amount numeric, tracking_reference text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.can_review_bike_leases(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view Spiro bike lease applications';
  END IF;

  RETURN QUERY
  SELECT s.id, s.customer_id, s.client_name, s.client_phone, s.model_type,
         COALESCE(NULLIF(s.valuation_amount, 0), NULLIF(s.total_amount, 0),
                  NULLIF(s.total_revenue, 0), 0) AS valuation_amount,
         COALESCE(NULLIF(s.payment_projection, 0),
                  round(COALESCE(NULLIF(s.valuation_amount, 0), NULLIF(s.total_amount, 0),
                                 NULLIF(s.total_revenue, 0), 0) * COALESCE(s.lease_daily_rate, 0.15))
         ) AS payment_projection,
         COALESCE(s.lease_term_months, 12) AS lease_term_months,
         COALESCE(s.lease_daily_rate, 0.15) AS lease_daily_rate,
         s.amount_outstanding, s.amount_paid,
         COALESCE(s.order_status, 'submitted') AS order_status,
         s.rejection_reason, s.created_at,
         s.coo_approved_at, s.cfo_disbursed_at, s.lease_activated_at,
         s.disbursed_amount, s.tracking_reference
  FROM public.merchandise_sales s
  WHERE lower(COALESCE(s.item_name, '')) LIKE '%spiro%'
    AND (p_status IS NULL OR COALESCE(s.order_status, 'submitted') = p_status)
  ORDER BY s.created_at DESC
  LIMIT 300;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_order_spiro_bike_lease(text, numeric, integer, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coo_approve_bike_lease(uuid, numeric, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_disburse_bike_lease(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_bike_lease(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_bike_lease_orders(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_review_bike_leases(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_coo_approve_bike_leases(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_cfo_disburse_bike_leases(uuid) TO authenticated;