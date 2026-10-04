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
  -- Supplier is intentionally optional at application time. Agent Ops assigns
  -- the supplier after the application is received.

  v_price := COALESCE(v_cat.default_amount, 0);
  IF v_price <= 0 THEN
    RAISE EXCEPTION 'Selected phone has no price set';
  END IF;

  v_elig := public.get_agent_smartphone_eligibility(v_uid);
  IF NOT (v_elig->>'eligible')::boolean THEN
    IF (v_elig->>'has_open_application')::boolean THEN
      RAISE EXCEPTION 'You already have an application in progress';
    ELSE
      RAISE EXCEPTION 'This programme is limited to active operational agents';
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
    'Smartphone advance application - ' || v_cat.brand || ' ' || COALESCE(v_cat.model_name, '')
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