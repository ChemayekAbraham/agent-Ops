-- ============ Catalogue: supplier attachment ============
ALTER TABLE public.smartphone_catalog
  ADD COLUMN IF NOT EXISTS supplier_id uuid,
  ADD COLUMN IF NOT EXISTS supplier_name text,
  ADD COLUMN IF NOT EXISTS supplier_phone text;

-- ============ Sales: advance metadata ============
ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS smartphone_catalog_id uuid,
  ADD COLUMN IF NOT EXISTS supplier_id uuid,
  ADD COLUMN IF NOT EXISTS advance_period_months integer,
  ADD COLUMN IF NOT EXISTS advance_markup_pct numeric,
  ADD COLUMN IF NOT EXISTS total_repayable numeric,
  ADD COLUMN IF NOT EXISTS grace_days integer DEFAULT 14,
  ADD COLUMN IF NOT EXISTS repayment_starts_on date,
  ADD COLUMN IF NOT EXISTS applicant_rank integer,
  ADD COLUMN IF NOT EXISTS rank_cap numeric,
  ADD COLUMN IF NOT EXISTS ops_approved_by uuid,
  ADD COLUMN IF NOT EXISTS ops_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS overdue_surcharge_total numeric DEFAULT 0;

-- ============ Recovery plans: grace + late charge tracking ============
ALTER TABLE public.merchandise_recovery_plans
  ADD COLUMN IF NOT EXISTS starts_on date,
  ADD COLUMN IF NOT EXISTS overdue_surcharge_total numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_surcharge_on date;

-- ============ Programme constants ============
CREATE OR REPLACE FUNCTION public.smartphone_period_markup(p_months integer)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE p_months
    WHEN 3 THEN 33
    WHEN 6 THEN 36
    WHEN 9 THEN 39
    WHEN 12 THEN 42
    ELSE NULL
  END::numeric
$$;

CREATE OR REPLACE FUNCTION public.smartphone_period_days(p_months integer)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE p_months
    WHEN 3 THEN 90
    WHEN 6 THEN 180
    WHEN 9 THEN 270
    WHEN 12 THEN 365
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION public.smartphone_rank_cap(p_rank integer)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p_rank IS NULL THEN 0
    WHEN p_rank BETWEEN 1 AND 10 THEN 1000000
    WHEN p_rank BETWEEN 11 AND 20 THEN 800000
    WHEN p_rank BETWEEN 21 AND 30 THEN 600000
    WHEN p_rank BETWEEN 31 AND 40 THEN 400000
    WHEN p_rank BETWEEN 41 AND 50 THEN 200000
    ELSE 0
  END::numeric
$$;

-- ============ Top-50 operational leaderboard ============
CREATE OR REPLACE FUNCTION public.smartphone_leaderboard_ranks()
RETURNS TABLE(agent_id uuid, collected numeric, rank integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH qa AS (
    SELECT q.agent_id FROM public.agent_ops_qualifying_agent_ids() q
  ),
  totals AS (
    SELECT qa.agent_id,
           COALESCE(SUM(c.amount), 0)::numeric AS collected
    FROM qa
    LEFT JOIN public.agent_collections c
      ON c.agent_id = qa.agent_id
     AND c.created_at >= now() - interval '30 days'
    GROUP BY qa.agent_id
  )
  SELECT agent_id, collected,
         (ROW_NUMBER() OVER (ORDER BY collected DESC, agent_id))::int AS rank
  FROM totals
  WHERE collected > 0
  ORDER BY collected DESC
  LIMIT 50
$$;

CREATE OR REPLACE FUNCTION public.can_ops_approve_smartphone_orders(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.has_role(_user_id, 'agent_ops')
      OR public.has_role(_user_id, 'operations')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
$$;

-- ============ Eligibility ============
CREATE OR REPLACE FUNCTION public.get_agent_smartphone_eligibility(p_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_rank integer;
  v_collected numeric;
  v_cap numeric;
  v_has_id boolean;
  v_has_workplace boolean;
  v_open integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_uid <> auth.uid()
     AND NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT l.rank, l.collected INTO v_rank, v_collected
  FROM public.smartphone_leaderboard_ranks() l
  WHERE l.agent_id = v_uid;

  v_cap := public.smartphone_rank_cap(v_rank);

  SELECT COALESCE(NULLIF(btrim(COALESCE(national_id, '')), ''), '') <> ''
  INTO v_has_id FROM public.profiles WHERE id = v_uid;

  SELECT EXISTS (
    SELECT 1 FROM public.venue_visits
    WHERE user_id = v_uid AND category = 'workplace'
  ) INTO v_has_workplace;

  SELECT count(*) INTO v_open
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND lower(COALESCE(item_name, '')) LIKE '%phone%'
    AND COALESCE(order_status, 'submitted') IN ('pending_approval','submitted','ops_approved','coo_approved')
  ;

  RETURN jsonb_build_object(
    'user_id', v_uid,
    'rank', v_rank,
    'collected_30d', COALESCE(v_collected, 0),
    'max_amount', COALESCE(v_cap, 0),
    'has_national_id', COALESCE(v_has_id, false),
    'has_workplace_verification', COALESCE(v_has_workplace, false),
    'has_open_application', v_open > 0,
    'eligible', COALESCE(v_cap, 0) > 0
                AND COALESCE(v_has_id, false)
                AND COALESCE(v_has_workplace, false)
                AND v_open = 0
  );
END;
$$;

-- ============ Application ============
DROP FUNCTION IF EXISTS public.agent_order_smartphone(numeric, text, text);
DROP FUNCTION IF EXISTS public.agent_order_smartphone(numeric);

CREATE OR REPLACE FUNCTION public.agent_order_smartphone(p_catalog_id uuid, p_period_months integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_elig jsonb;
  v_cat public.smartphone_catalog;
  v_price numeric;
  v_markup numeric;
  v_days integer;
  v_total numeric;
  v_daily numeric;
  v_name text;
  v_phone text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_markup := public.smartphone_period_markup(p_period_months);
  v_days := public.smartphone_period_days(p_period_months);
  IF v_markup IS NULL OR v_days IS NULL THEN
    RAISE EXCEPTION 'Choose a repayment period of 3, 6, 9 or 12 months';
  END IF;

  SELECT * INTO v_cat FROM public.smartphone_catalog WHERE id = p_catalog_id AND is_active;
  IF v_cat.id IS NULL THEN
    RAISE EXCEPTION 'Selected phone is not available';
  END IF;
  IF v_cat.supplier_id IS NULL THEN
    RAISE EXCEPTION 'This phone has no registered supplier yet. Please choose another.';
  END IF;

  v_price := COALESCE(v_cat.default_amount, 0);
  IF v_price <= 0 THEN
    RAISE EXCEPTION 'Selected phone has no price set';
  END IF;

  v_elig := public.get_agent_smartphone_eligibility(v_uid);
  IF NOT (v_elig->>'eligible')::boolean THEN
    IF (v_elig->>'has_open_application')::boolean THEN
      RAISE EXCEPTION 'You already have an application in progress';
    ELSIF NOT (v_elig->>'has_national_id')::boolean THEN
      RAISE EXCEPTION 'Add your national ID to your profile before applying';
    ELSIF NOT (v_elig->>'has_workplace_verification')::boolean THEN
      RAISE EXCEPTION 'A verified workplace visit is required before applying';
    ELSE
      RAISE EXCEPTION 'This programme is limited to the top 50 agents on the operational leaderboard';
    END IF;
  END IF;

  IF v_price > (v_elig->>'max_amount')::numeric THEN
    RAISE EXCEPTION 'Your current position allows a phone of up to UGX %',
      to_char((v_elig->>'max_amount')::numeric, 'FM999,999,999');
  END IF;

  v_total := round(v_price + (v_price * v_markup / 100));
  v_daily := ceil(v_total::numeric / v_days);

  SELECT full_name, phone INTO v_name, v_phone FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, total_revenue, total_amount,
    client_name, client_phone, customer_id, created_by,
    payment_status, order_status, sale_date,
    brand, model_type,
    smartphone_catalog_id, supplier_id,
    advance_period_months, advance_markup_pct, total_repayable,
    access_daily_amount, access_repayment_days, grace_days,
    applicant_rank, rank_cap, payment_projection,
    amount_outstanding, amount_paid,
    notes
  ) VALUES (
    'Welile Smartphone', 1, v_price, v_price, v_price,
    v_name, v_phone, v_uid, v_uid,
    'credit', 'pending_approval', current_date,
    v_cat.brand, v_cat.model_name,
    v_cat.id, v_cat.supplier_id,
    p_period_months, v_markup, v_total,
    v_daily, v_days, 14,
    (v_elig->>'rank')::int, (v_elig->>'max_amount')::numeric, v_total - v_price,
    0, 0,
    'Smartphone advance application - ' || v_cat.brand || ' ' || v_cat.model_name
      || ' over ' || p_period_months::text || ' months'
  ) RETURNING id INTO v_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_advance_requested', 'merchandise_sales', v_id,
            'Agent submitted a smartphone advance application for Agent Ops review',
            jsonb_build_object('price', v_price, 'total_repayable', v_total,
                               'period_months', p_period_months, 'daily', v_daily));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', v_id,
    'order_status', 'pending_approval',
    'total_repayable', v_total,
    'daily_amount', v_daily,
    'repayment_days', v_days,
    'period_months', p_period_months
  );
END;
$$;

-- ============ Stage 1: Agent Ops ============
CREATE OR REPLACE FUNCTION public.agent_ops_approve_smartphone_order(p_sale_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
BEGIN
  IF NOT public.can_ops_approve_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve smartphone applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') NOT IN ('pending_approval','submitted') THEN
    RAISE EXCEPTION 'Application is already %', v_sale.order_status;
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'ops_approved',
      ops_approved_by = v_uid,
      ops_approved_at = now(),
      notes = COALESCE(notes, '') || ' | Agent Ops approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
    VALUES (v_uid, 'smartphone_advance_ops_approved', 'merchandise_sales', p_sale_id,
            'Agent Ops verified eligibility and forwarded the smartphone advance to the COO');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'ops_approved');
END;
$$;

-- ============ Stage 2: COO ============
DROP FUNCTION IF EXISTS public.coo_approve_smartphone_order(uuid, numeric, text, numeric, integer);

CREATE OR REPLACE FUNCTION public.coo_approve_smartphone_order(p_sale_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
BEGIN
  IF NOT public.can_coo_approve_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to approve smartphone applications';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'ops_approved' THEN
    RAISE EXCEPTION 'Application must be approved by Agent Ops first (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved',
      coo_approved_by = v_uid,
      coo_approved_at = now(),
      notes = COALESCE(notes, '') || ' | COO approved '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' - forwarded to CFO for supplier payment'
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
    VALUES (v_uid, 'smartphone_advance_coo_approved', 'merchandise_sales', p_sale_id,
            'COO approved the smartphone advance and forwarded it to the CFO for supplier payment');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'coo_approved');
END;
$$;

-- ============ Stage 3: CFO pays the supplier ============
DROP FUNCTION IF EXISTS public.cfo_disburse_smartphone_order(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.cfo_disburse_smartphone_order(uuid, text);

CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(p_sale_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_price numeric;
  v_total numeric;
  v_daily numeric;
  v_days integer;
  v_start date;
  v_ref text;
  v_group uuid;
  v_supplier uuid;
  v_agent_name text;
  v_supplier_name text;
BEGIN
  IF NOT public.can_cfo_disburse_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to disburse smartphone advances';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved first (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;
  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;

  v_supplier := v_sale.supplier_id;
  IF v_supplier IS NULL THEN
    SELECT supplier_id INTO v_supplier FROM public.smartphone_catalog WHERE id = v_sale.smartphone_catalog_id;
  END IF;
  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'No registered supplier is attached to this phone';
  END IF;

  v_price := COALESCE(NULLIF(v_sale.total_amount, 0), NULLIF(v_sale.unit_price, 0), 0);
  IF v_price <= 0 THEN
    RAISE EXCEPTION 'Phone price is missing on this application';
  END IF;

  v_days  := COALESCE(NULLIF(v_sale.access_repayment_days, 0),
                      public.smartphone_period_days(COALESCE(v_sale.advance_period_months, 12)), 365);
  v_total := COALESCE(NULLIF(v_sale.total_repayable, 0),
                      round(v_price + v_price * COALESCE(v_sale.advance_markup_pct, 42) / 100));
  v_daily := COALESCE(NULLIF(v_sale.access_daily_amount, 0), ceil(v_total::numeric / v_days));
  v_start := current_date + COALESCE(NULLIF(v_sale.grace_days, 0), 14);

  SELECT full_name INTO v_agent_name FROM public.profiles WHERE id = v_sale.customer_id;
  SELECT full_name INTO v_supplier_name FROM public.profiles WHERE id = v_supplier;

  v_ref := 'smartphone-supplier-payment-' || p_sale_id::text;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_supplier,
        'amount', v_price,
        'direction', 'cash_in',
        'category', 'supplier_payment',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_sales',
        'source_id', p_sale_id,
        'reference_id', v_ref,
        'currency', 'UGX',
        'description', 'Smartphone supplier payment for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      ),
      jsonb_build_object(
        'user_id', v_uid,
        'amount', v_price,
        'direction', 'cash_out',
        'category', 'equipment_expense',
        'ledger_scope', 'platform',
        'source_table', 'merchandise_sales',
        'source_id', p_sale_id,
        'reference_id', v_ref,
        'currency', 'UGX',
        'description', 'Smartphone purchased from ' || COALESCE(v_supplier_name, 'supplier')
                       || ' for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      )
    ),
    v_ref
  );

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      payment_status = 'credit',
      total_repayable = v_total,
      access_daily_amount = v_daily,
      access_repayment_days = v_days,
      repayment_starts_on = v_start,
      payment_projection = v_total - v_price,
      amount_outstanding = v_total,
      supplier_id = v_supplier,
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_price,
      disbursement_group_id = v_group,
      notes = COALESCE(notes, '') || ' | CFO paid supplier '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' amount ' || to_char(v_price, 'FM999,999,999')
              || ' - daily ' || to_char(v_daily, 'FM999,999,999')
              || ' from ' || to_char(v_start, 'YYYY-MM-DD')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, daily_deduction_amount,
      starts_on, created_by
    ) VALUES (
      p_sale_id, v_sale.customer_id, COALESCE(v_agent_name, v_sale.client_name), v_sale.client_phone,
      COALESCE(v_sale.item_name, 'Welile Smartphone'),
      v_total, v_total, 0, v_daily, v_start, v_uid
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_total,
        outstanding_balance = GREATEST(v_total - COALESCE(amount_recovered, 0), 0),
        daily_deduction_amount = v_daily,
        starts_on = v_start,
        updated_at = now()
    WHERE sale_id = p_sale_id AND status = 'active';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_advance_disbursed', 'merchandise_sales', p_sale_id,
            'CFO paid the registered supplier directly and activated the agent smartphone advance recovery plan',
            jsonb_build_object('supplier_id', v_supplier, 'amount', v_price,
                               'total_repayable', v_total, 'daily_amount', v_daily,
                               'starts_on', v_start, 'transaction_group_id', v_group));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'supplier_id', v_supplier,
    'supplier_paid', v_price,
    'total_repayable', v_total,
    'daily_amount', v_daily,
    'repayment_starts_on', v_start,
    'transaction_group_id', v_group
  );
END;
$$;

-- Keep the single-entry approval router aligned with the new chain
CREATE OR REPLACE FUNCTION public.approve_smartphone_order(p_sale_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_status text;
BEGIN
  SELECT COALESCE(order_status, 'submitted') INTO v_status
  FROM public.merchandise_sales WHERE id = p_sale_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;

  IF v_status IN ('pending_approval','submitted') THEN
    RETURN public.agent_ops_approve_smartphone_order(p_sale_id, p_note);
  ELSIF v_status = 'ops_approved' THEN
    RETURN public.coo_approve_smartphone_order(p_sale_id, p_note);
  ELSIF v_status = 'coo_approved' THEN
    RETURN public.cfo_disburse_smartphone_order(p_sale_id, p_note);
  END IF;

  RAISE EXCEPTION 'Application is already %', v_status;
END;
$$;

-- ============ Reviewer list ============
DROP FUNCTION IF EXISTS public.list_smartphone_orders(text);

CREATE OR REPLACE FUNCTION public.list_smartphone_orders(p_status text DEFAULT NULL)
RETURNS TABLE(
  id uuid, customer_id uuid, client_name text, client_phone text,
  brand text, model_type text, total_amount numeric, payment_projection numeric,
  amount_outstanding numeric, amount_paid numeric, order_status text,
  rejection_reason text, created_at timestamptz,
  ops_approved_at timestamptz, coo_approved_at timestamptz, cfo_disbursed_at timestamptz,
  disbursed_amount numeric, access_daily_amount numeric, access_repayment_days integer,
  advance_period_months integer, advance_markup_pct numeric, total_repayable numeric,
  repayment_starts_on date, applicant_rank integer, rank_cap numeric,
  supplier_id uuid, supplier_name text, overdue_surcharge_total numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view smartphone applications';
  END IF;

  RETURN QUERY
  SELECT s.id, s.customer_id, s.client_name, s.client_phone, s.brand, s.model_type,
         COALESCE(NULLIF(s.total_amount, 0), NULLIF(s.total_revenue, 0),
                  NULLIF(s.unit_price * GREATEST(COALESCE(s.quantity, 1), 1), 0), 0) AS total_amount,
         COALESCE(s.payment_projection, 0) AS payment_projection,
         s.amount_outstanding, s.amount_paid,
         COALESCE(s.order_status, 'submitted') AS order_status,
         s.rejection_reason, s.created_at,
         s.ops_approved_at, s.coo_approved_at, s.cfo_disbursed_at, s.disbursed_amount,
         s.access_daily_amount, s.access_repayment_days,
         s.advance_period_months, s.advance_markup_pct, s.total_repayable,
         s.repayment_starts_on, s.applicant_rank, s.rank_cap,
         s.supplier_id, sp.full_name AS supplier_name,
         COALESCE(s.overdue_surcharge_total, 0) AS overdue_surcharge_total
  FROM public.merchandise_sales s
  LEFT JOIN public.profiles sp ON sp.id = s.supplier_id
  WHERE lower(COALESCE(s.item_name, '')) LIKE '%phone%'
    AND (p_status IS NULL OR COALESCE(s.order_status, 'submitted') = p_status)
  ORDER BY s.created_at DESC
  LIMIT 300;
END;
$$;

-- ============ Rejection: allow the new stage ============
CREATE OR REPLACE FUNCTION public.reject_smartphone_order(p_sale_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
BEGIN
  IF NOT public.can_review_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to reject smartphone applications';
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
    AND COALESCE(order_status, 'submitted') IN ('pending_approval','submitted','ops_approved','coo_approved');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found or already processed';
  END IF;

  UPDATE public.merchandise_recovery_plans
     SET status = 'cancelled', outstanding_balance = 0, updated_at = now()
   WHERE sale_id = p_sale_id AND status = 'active';

  RETURN jsonb_build_object('sale_id', p_sale_id, 'order_status', 'rejected');
END;
$$;

-- ============ Recovery: grace period + fixed daily amount ============
CREATE OR REPLACE FUNCTION public.recover_merchandise_from_wallets()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_plan            record;
  v_avail           numeric;
  v_amount          numeric;
  v_closing         numeric;
  v_ref             uuid;
  v_idem            text;
  v_desc            text;
  v_plans_touched   int := 0;
  v_recovered_total numeric := 0;
  v_failures        int := 0;
  v_skipped_grace   int := 0;
  v_last_error      text;
BEGIN
  FOR v_plan IN
    SELECT * FROM public.merchandise_recovery_plans
    WHERE status = 'active' AND outstanding_balance > 0
    ORDER BY created_at ASC
  LOOP
    -- 14-day grace period (or whatever start date the plan carries)
    IF v_plan.starts_on IS NOT NULL AND v_plan.starts_on > current_date THEN
      v_skipped_grace := v_skipped_grace + 1;
      CONTINUE;
    END IF;

    v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;

    v_amount := LEAST(
      v_plan.outstanding_balance,
      v_avail,
      GREATEST(
        round(COALESCE(
          NULLIF(v_plan.daily_deduction_amount, 0),
          COALESCE(v_plan.original_amount, v_plan.outstanding_balance) * COALESCE(v_plan.daily_rate, 0)
        )),
        1
      )
    );
    IF v_amount <= 0 THEN CONTINUE; END IF;

    v_ref  := gen_random_uuid();
    v_idem := 'merch_recover_' || v_plan.id::text || '_' || to_char(now(), 'YYYYMMDDHH24');
    v_desc := 'Merchandise Payment - ' || COALESCE(v_plan.item_name, 'Item') || ' (daily instalment)';

    BEGIN
      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'wallet',
            'direction', 'cash_out',
            'amount', v_amount,
            'category', 'agent_repayment',
            'recipient_type', 'user',
            'wallet_bucket', 'withdrawable',
            'source_table', 'merchandise_recovery_plans',
            'source_id', v_plan.id,
            'description', v_desc,
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'merchandise_daily_recovery',
              'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id
            )
          ),
          jsonb_build_object(
            'user_id', v_plan.customer_id,
            'ledger_scope', 'platform',
            'direction', 'cash_in',
            'amount', v_amount,
            'category', 'agent_repayment',
            'recipient_type', 'operational_wallet',
            'source_table', 'merchandise_recovery_plans',
            'source_id', v_plan.id,
            'description', 'Merchandise cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Item'),
            'currency', 'UGX',
            'metadata', jsonb_build_object(
              'source', 'merchandise_daily_recovery',
              'plan_id', v_plan.id,
              'sale_id', v_plan.sale_id,
              'from_customer', v_plan.customer_id,
              'item_name', v_plan.item_name
            )
          )
        ),
        idempotency_key => v_idem
      );

      v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);

      INSERT INTO public.merchandise_recovery_deductions (
        plan_id, sale_id, customer_id, item_name, amount, outstanding_before, outstanding_after, ledger_reference
      ) VALUES (
        v_plan.id, v_plan.sale_id, v_plan.customer_id, v_plan.item_name,
        v_amount, v_plan.outstanding_balance, v_closing, v_ref
      );

      UPDATE public.merchandise_recovery_plans
      SET outstanding_balance = v_closing,
          amount_recovered = amount_recovered + v_amount,
          last_recovery_at = now(),
          status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
          completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END,
          updated_at = now()
      WHERE id = v_plan.id;

      IF v_plan.sale_id IS NOT NULL THEN
        UPDATE public.merchandise_sales
        SET amount_paid = COALESCE(amount_paid, 0) + v_amount,
            amount_outstanding = v_closing,
            payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END,
            updated_at = now()
        WHERE id = v_plan.sale_id;
      END IF;

      v_plans_touched := v_plans_touched + 1;
      v_recovered_total := v_recovered_total + v_amount;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures + 1;
      v_last_error := SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'plans_touched', v_plans_touched,
    'recovered_total', v_recovered_total,
    'skipped_grace', v_skipped_grace,
    'failures', v_failures,
    'last_error', v_last_error
  );
END;
$$;

-- ============ Overdue surcharge: UGX 50,000 per month once 30 days behind ============
CREATE OR REPLACE FUNCTION public.apply_smartphone_overdue_surcharges()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_plan record;
  v_expected numeric;
  v_arrears numeric;
  v_applied int := 0;
  v_total numeric := 0;
BEGIN
  FOR v_plan IN
    SELECT p.*
    FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.status = 'active'
      AND p.outstanding_balance > 0
      AND p.starts_on IS NOT NULL
      AND p.starts_on <= current_date - 30
      AND COALESCE(p.daily_deduction_amount, 0) > 0
      AND lower(COALESCE(s.item_name, '')) LIKE '%phone%'
      AND (p.last_surcharge_on IS NULL OR p.last_surcharge_on <= current_date - 30)
  LOOP
    v_expected := v_plan.daily_deduction_amount * (current_date - v_plan.starts_on);
    v_arrears := v_expected - COALESCE(v_plan.amount_recovered, 0);

    IF v_arrears >= v_plan.daily_deduction_amount * 30 THEN
      UPDATE public.merchandise_recovery_plans
      SET outstanding_balance = outstanding_balance + 50000,
          original_amount = COALESCE(original_amount, 0) + 50000,
          overdue_surcharge_total = COALESCE(overdue_surcharge_total, 0) + 50000,
          last_surcharge_on = current_date,
          updated_at = now()
      WHERE id = v_plan.id;

      UPDATE public.merchandise_sales
      SET amount_outstanding = COALESCE(amount_outstanding, 0) + 50000,
          total_repayable = COALESCE(total_repayable, 0) + 50000,
          overdue_surcharge_total = COALESCE(overdue_surcharge_total, 0) + 50000,
          updated_at = now()
      WHERE id = v_plan.sale_id;

      v_applied := v_applied + 1;
      v_total := v_total + 50000;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('plans_charged', v_applied, 'total_charged', v_total);
END;
$$;