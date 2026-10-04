-- 1) Eligibility: ID + workplace visit are no longer application-time gates.
--    The flags are still reported so the pickup-day checklist can use them.
CREATE OR REPLACE FUNCTION public.get_agent_smartphone_eligibility(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- Pickup-day checklist: verified only when the phone is released.
    'pickup_verification_complete', COALESCE(v_has_id, false) AND COALESCE(v_has_workplace, false),
    'eligible', COALESCE(v_cap, 0) > 0
                AND v_open = 0
  );
END;
$function$;

-- 2) Application: drop the ID / workplace blockers.
CREATE OR REPLACE FUNCTION public.agent_order_smartphone(p_catalog_id uuid, p_period_months integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- 3) Pickup day: the phone is only released once the national ID and the
--    workplace photo/visit are verified.
CREATE OR REPLACE FUNCTION public.assert_smartphone_pickup_verified(p_agent_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_id boolean;
  v_has_workplace boolean;
BEGIN
  SELECT COALESCE(NULLIF(btrim(COALESCE(national_id, '')), ''), '') <> ''
  INTO v_has_id FROM public.profiles WHERE id = p_agent_id;

  SELECT EXISTS (
    SELECT 1 FROM public.venue_visits
    WHERE user_id = p_agent_id AND category = 'workplace'
  ) INTO v_has_workplace;

  IF NOT COALESCE(v_has_id, false) THEN
    RAISE EXCEPTION 'Pickup blocked: the agent national ID must be captured and verified on collection day';
  END IF;
  IF NOT COALESCE(v_has_workplace, false) THEN
    RAISE EXCEPTION 'Pickup blocked: a workplace photo / verified workplace visit must be captured on collection day';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_smartphone_pickup_verified(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_smartphone_pickup_verified(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(p_sale_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Collection-day verification gate.
  PERFORM public.assert_smartphone_pickup_verified(v_sale.customer_id);

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

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_advance_disbursed', 'merchandise_sales', p_sale_id,
            'CFO paid the registered supplier and released the phone after collection-day verification',
            jsonb_build_object('price', v_price, 'total_repayable', v_total,
                               'daily', v_daily, 'starts_on', v_start));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'disbursed_amount', v_price,
    'daily_amount', v_daily,
    'repayment_starts_on', v_start,
    'disbursement_group_id', v_group
  );
END;
$function$;