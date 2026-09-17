-- Merchandise instalment plans with a customer-chosen repayment period (1-12 months).
-- Reducing balance: monthly charge = 28% of that month's OPENING principal,
-- monthly principal = price / months, daily deduction = month due / days in month.
-- Reuses the existing reducing-balance generator and the per-date schedule reader
-- (public.smartphone_reducing_schedule / smartphone_plan_daily_for_date), which
-- recover_merchandise_from_wallets already honours for any sale_id.

CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise_plan(
  p_catalog_id uuid,
  p_quantity integer,
  p_size text DEFAULT NULL,
  p_term_months integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_item      record;
  v_total     numeric;
  v_name      text;
  v_phone     text;
  v_sale_id   uuid;
  v_size      text := NULLIF(btrim(COALESCE(p_size, '')), '');
  v_months    integer := COALESCE(p_term_months, 1);
  v_dupe      uuid;
  v_sched     jsonb;
  v_repayable numeric;
  v_daily     numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF v_months NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Choose a repayment period between 1 and 12 months';
  END IF;

  SELECT * INTO v_item
  FROM public.merchandise_catalog
  WHERE id = p_catalog_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This item is not available';
  END IF;

  IF COALESCE(array_length(v_item.sizes, 1), 0) > 0 THEN
    IF v_size IS NULL THEN
      RAISE EXCEPTION 'Please choose a size for this item';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM unnest(v_item.sizes) s WHERE lower(btrim(s)) = lower(v_size)
    ) THEN
      RAISE EXCEPTION 'Size % is not in stock for this item', v_size;
    END IF;
    SELECT s INTO v_size FROM unnest(v_item.sizes) s WHERE lower(btrim(s)) = lower(v_size) LIMIT 1;
  ELSE
    v_size := NULL;
  END IF;

  v_total := COALESCE(v_item.unit_price, 0) * p_quantity;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Invalid order total';
  END IF;

  SELECT id INTO v_dupe
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND item_name = v_item.item_name
    AND quantity = p_quantity
    AND COALESCE(selected_size, '') = COALESCE(v_size, '')
    AND created_at > now() - interval '5 minutes'
    AND COALESCE(order_status, 'submitted') NOT IN ('rejected','failed')
  LIMIT 1;
  IF v_dupe IS NOT NULL THEN
    RAISE EXCEPTION 'You already placed this exact order moments ago. Check your orders before trying again.';
  END IF;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  -- Nothing is taken at checkout: the whole price is financed over the chosen
  -- period and recovered daily from the wallet, so no ledger legs are posted here.
  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes,
    order_status, payment_plan, selected_size
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, 'credit',
    0, v_total, current_date, v_uid,
    'Agent store - ' || v_months || '-month instalment plan (reducing balance, daily wallet recovery)'
      || COALESCE(' | Size: ' || v_size, ''),
    'pending_approval', 'installment', v_size
  ) RETURNING id INTO v_sale_id;

  -- Build the reducing-balance schedule the daily recovery run reads.
  v_sched := public.smartphone_rebuild_repayment_schedule(v_sale_id, v_total, v_months, current_date);
  v_repayable := GREATEST(v_total, COALESCE((v_sched->>'total_repayable')::numeric, v_total));
  v_daily := GREATEST(1, COALESCE((v_sched->>'first_daily')::numeric, 0));

  -- The recovery plan is created by trg_create_merchandise_recovery_plan on the
  -- insert above with the price only. Restate it against the financed total so
  -- recovery collects the monthly charges as well, and pin the month-1 daily
  -- amount (later months are read from the schedule).
  UPDATE public.merchandise_recovery_plans
     SET original_amount = v_repayable,
         outstanding_balance = v_repayable,
         daily_deduction_amount = v_daily,
         starts_on = COALESCE(starts_on, current_date),
         updated_at = now()
   WHERE sale_id = v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'total', v_total,
    'paid_now', 0,
    'outstanding', v_repayable,
    'term_months', v_months,
    'total_repayable', v_repayable,
    'first_daily', v_daily,
    'last_daily', COALESCE((v_sched->>'last_daily')::numeric, v_daily),
    'payment_plan', 'installment',
    'selected_size', v_size
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_purchase_merchandise_plan(uuid, integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_purchase_merchandise_plan(uuid, integer, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_purchase_merchandise_plan(uuid, integer, text, integer) TO service_role;