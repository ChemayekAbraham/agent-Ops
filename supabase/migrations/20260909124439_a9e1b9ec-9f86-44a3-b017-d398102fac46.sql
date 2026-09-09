-- Who may run the Agent Ops verification step on bike lease applications.
CREATE OR REPLACE FUNCTION public.can_ops_verify_bike_leases(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.has_role(_user_id, 'agent_ops')
      OR public.has_role(_user_id, 'operations')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$function$;

-- Step 1: Agent Ops verification.
CREATE OR REPLACE FUNCTION public.agent_ops_verify_bike_lease(p_sale_id uuid, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
BEGIN
  IF NOT public.can_ops_verify_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to verify Spiro bike lease applications';
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

  UPDATE public.merchandise_sales
  SET order_status = 'ops_approved',
      ops_approved_by = v_uid,
      ops_approved_at = now(),
      notes = COALESCE(notes, '') || ' | Agent Ops verified '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' - forwarded to the COO for approval'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
    VALUES (v_uid, 'bike_lease_ops_verified', 'merchandise_sales', p_sale_id,
            'Agent Ops verified the Spiro bike lease application and forwarded it to the COO');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'ops_approved');
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_ops_verify_bike_lease(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_verify_bike_lease(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.can_ops_verify_bike_leases(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_ops_verify_bike_leases(uuid) TO authenticated;

-- Step 2: COO approval now requires the Agent Ops verification first.
CREATE OR REPLACE FUNCTION public.coo_approve_bike_lease(p_sale_id uuid, p_valuation numeric DEFAULT NULL::numeric, p_lease_term_months integer DEFAULT NULL::integer, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  IF COALESCE(v_sale.order_status, 'submitted') IN ('submitted','pending_approval') THEN
    RAISE EXCEPTION 'Agent Ops must verify this application before the COO can approve it';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'ops_approved' THEN
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
              || ' over ' || v_term || ' months - forwarded to CFO for disbursement'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved the Spiro bike lease valuation and forwarded it to the CFO for disbursement',
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
$function$;

-- Step 3: CFO disburses the funds into the ordering agent's own wallet.
CREATE OR REPLACE FUNCTION public.cfo_disburse_bike_lease(p_sale_id uuid, p_valuation numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_recover numeric;
  v_rate numeric;
  v_term integer;
  v_customer uuid;
  v_name text;
  v_ref text;
  v_group uuid;
BEGIN
  IF NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to release Spiro bikes';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved before disbursement (currently %)', COALESCE(v_sale.order_status, 'submitted');
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

  -- Money goes to the ordering agent's own wallet. Idempotent on reference.
  v_ref := 'bike-lease-disbursement-' || p_sale_id::text;

  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_customer,
          'amount', v_valuation,
          'direction', 'cash_in',
          'category', 'agent_advance_credit',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
          'description', 'Bike lease disbursement to ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_uid,
          'amount', v_valuation,
          'direction', 'cash_out',
          'category', 'equipment_expense',
          'ledger_scope', 'platform',
          'source_table', 'merchandise_sales',
          'source_id', p_sale_id,
          'reference_id', v_ref,
          'currency', 'UGX',
          'description', 'Bike lease funded for ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        )
      ),
      v_ref
    );
  END IF;

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
      disbursement_group_id = COALESCE(v_group, disbursement_group_id),
      lease_activated_at = now(),
      notes = COALESCE(notes, '') || ' | CFO disbursed to the agent wallet and activated the lease '
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
            'CFO disbursed the bike funds to the ordering agent wallet and activated the recovery lease',
            jsonb_build_object('valuation', v_valuation, 'recovery_amount', v_recover,
                               'daily_rate', v_rate, 'lease_term_months', v_term,
                               'credited_agent_id', v_customer, 'reference_id', v_ref));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'valuation', v_valuation,
    'recovery_amount', v_recover,
    'daily_rate', v_rate,
    'lease_term_months', v_term,
    'credited_agent_id', v_customer,
    'disbursement_group_id', v_group
  );
END;
$function$;

-- Rejections may also happen at the Agent Ops verification stage.
CREATE OR REPLACE FUNCTION public.reject_bike_lease(p_sale_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  IF v_status NOT IN ('submitted','pending_approval','ops_approved','coo_approved') THEN
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
$function$;

-- Queue listing now exposes the Agent Ops verification stamp.
DROP FUNCTION IF EXISTS public.list_bike_lease_orders(text);
CREATE FUNCTION public.list_bike_lease_orders(p_status text DEFAULT NULL::text)
RETURNS TABLE(id uuid, customer_id uuid, client_name text, client_phone text, model_type text, valuation_amount numeric, payment_projection numeric, lease_term_months integer, lease_daily_rate numeric, amount_outstanding numeric, amount_paid numeric, order_status text, rejection_reason text, created_at timestamp with time zone, ops_approved_at timestamp with time zone, coo_approved_at timestamp with time zone, cfo_disbursed_at timestamp with time zone, lease_activated_at timestamp with time zone, disbursed_amount numeric, tracking_reference text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
         s.ops_approved_at, s.coo_approved_at, s.cfo_disbursed_at, s.lease_activated_at,
         s.disbursed_amount, s.tracking_reference
  FROM public.merchandise_sales s
  WHERE lower(COALESCE(s.item_name, '')) LIKE '%spiro%'
    AND (p_status IS NULL OR COALESCE(s.order_status, 'submitted') = p_status)
  ORDER BY s.created_at DESC
  LIMIT 300;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_bike_lease_orders(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_bike_lease_orders(text) TO authenticated;