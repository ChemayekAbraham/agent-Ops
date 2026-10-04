CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise(p_catalog_id uuid, p_quantity integer, p_payment_mode text DEFAULT 'full'::text)
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
    -- Zero-balance installments are allowed: nothing is debited now and the
    -- full price becomes the outstanding balance recovered at 25% per run.
    v_down := GREATEST(0, LEAST(COALESCE(v_avail, 0), GREATEST(round(v_total * 0.25), 1)));
  END IF;

  v_out := v_total - v_down;
  v_status := CASE
    WHEN v_out <= 0 THEN 'paid'
    WHEN v_down <= 0 THEN 'credit'
    ELSE 'partial'
  END;

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
    CASE WHEN v_mode = 'installment' AND v_down <= 0
      THEN 'Agent store - installment plan, zero wallet balance (25% wallet recovery)'
    WHEN v_mode = 'installment'
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
          'category', 'agent_repayment',
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
          'category', 'agent_repayment',
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