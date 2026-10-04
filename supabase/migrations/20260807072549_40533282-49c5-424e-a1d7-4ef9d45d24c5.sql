-- Reduce merchandise installment recovery rate from 40% to 25%

-- 1. Update recovery-plan trigger for new installment sales
CREATE OR REPLACE FUNCTION public.create_merchandise_recovery_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_customer uuid;
  v_name text;
  v_rate numeric;
BEGIN
  IF COALESCE(NEW.amount_outstanding, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_customer := NEW.customer_id;
  IF v_customer IS NULL AND NEW.client_phone IS NOT NULL
     AND public.normalize_phone_9(NEW.client_phone) <> '' THEN
    SELECT id INTO v_customer
    FROM public.profiles
    WHERE public.normalize_phone_9(phone) = public.normalize_phone_9(NEW.client_phone)
    LIMIT 1;
  END IF;

  IF v_customer IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  v_rate := CASE WHEN COALESCE(NEW.payment_plan, 'full') = 'installment' THEN 0.25 ELSE 0.15 END;

  INSERT INTO public.merchandise_recovery_plans (
    sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by
  ) VALUES (
    NEW.id, v_customer, COALESCE(v_name, NEW.client_name), NEW.client_phone, NEW.item_name,
    NEW.amount_outstanding, NEW.amount_outstanding, v_rate, NEW.created_by
  );

  RETURN NEW;
END;
$function$;

-- 2. Update purchase RPC to take 25% down-payment on installment plans
CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise(
  p_catalog_id uuid,
  p_quantity integer,
  p_payment_mode text DEFAULT 'full'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_item     record;
  v_total    numeric;
  v_avail    numeric;
  v_name     text;
  v_phone    text;
  v_sale_id  uuid;
  v_mode     text := lower(COALESCE(p_payment_mode, 'full'));
  v_down     numeric;
  v_out      numeric;
  v_status   text;
  v_dupe     uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF v_mode NOT IN ('full','installment') THEN
    RAISE EXCEPTION 'Invalid payment mode';
  END IF;

  SELECT * INTO v_item
  FROM public.merchandise_catalog
  WHERE id = p_catalog_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This item is not available';
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
    AND created_at > now() - interval '5 minutes'
    AND COALESCE(order_status, 'submitted') NOT IN ('rejected','failed')
  LIMIT 1;
  IF v_dupe IS NOT NULL THEN
    RAISE EXCEPTION 'You already placed this exact order moments ago. Check your orders before trying again.';
  END IF;

  v_avail := COALESCE(public.get_user_available_balance(v_uid), 0);

  IF v_mode = 'full' THEN
    IF v_avail < v_total THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Your wallet has UGX % but this order needs UGX %', v_avail, v_total
        USING ERRCODE = 'P0001';
    END IF;
    v_down := v_total;
  ELSE
    v_down := LEAST(v_total, GREATEST(round(v_avail * 0.25), 0));
    IF v_down <= 0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Your wallet has UGX % — you need a wallet balance to start an installment plan', v_avail
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_out := v_total - v_down;
  v_status := CASE WHEN v_out <= 0 THEN 'paid' ELSE 'partial' END;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes,
    order_status, payment_plan
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, v_status,
    v_down, v_out, current_date, v_uid,
    CASE WHEN v_mode = 'installment'
      THEN 'Agent store - installment plan (25% wallet recovery)'
      ELSE 'Agent store - instant wallet debit' END,
    'processing', v_mode
  ) RETURNING id INTO v_sale_id;

  IF v_down > 0 THEN
    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', v_uid,
          'ledger_scope', 'wallet',
          'direction', 'cash_out',
          'amount', v_down,
          'category', 'wallet_deduction',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', v_sale_id,
          'description', CASE WHEN v_mode = 'installment'
            THEN 'Merchandise Installment (25%) - ' || v_item.item_name
            ELSE 'Merchandise Purchase - ' || v_item.item_name END,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', CASE WHEN v_mode = 'installment' THEN 'merchandise_installment_downpayment' ELSE 'merchandise_instant_purchase' END,
            'sale_id', v_sale_id,
            'catalog_id', v_item.id,
            'quantity', p_quantity,
            'payment_plan', v_mode,
            'order_total', v_total
          )
        ),
        jsonb_build_object(
          'user_id', v_uid,
          'ledger_scope', 'platform',
          'direction', 'cash_in',
          'amount', v_down,
          'category', 'debt_recovery',
          'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_sales',
          'source_id', v_sale_id,
          'description', 'Merchandise Sale - ' || v_item.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', CASE WHEN v_mode = 'installment' THEN 'merchandise_installment_downpayment' ELSE 'merchandise_instant_purchase' END,
            'sale_id', v_sale_id,
            'catalog_id', v_item.id,
            'quantity', p_quantity,
            'payment_plan', v_mode,
            'order_total', v_total
          )
        )
      ),
      idempotency_key => 'merch_purchase_' || v_sale_id::text,
      skip_balance_check => false
    );
  END IF;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', v_item.item_name,
    'quantity', p_quantity,
    'total', v_total,
    'payment_plan', v_mode,
    'paid_now', v_down,
    'outstanding', v_out
  );
END;
$function$;

-- 3. Backfill existing active installment recovery plans to the new 25% rate
UPDATE public.merchandise_recovery_plans
SET daily_rate = 0.25,
    updated_at = now()
WHERE status = 'active'
  AND outstanding_balance > 0
  AND daily_rate = 0.40
  AND EXISTS (
    SELECT 1 FROM public.merchandise_sales s
    WHERE s.id = merchandise_recovery_plans.sale_id
      AND s.payment_plan = 'installment'
  );