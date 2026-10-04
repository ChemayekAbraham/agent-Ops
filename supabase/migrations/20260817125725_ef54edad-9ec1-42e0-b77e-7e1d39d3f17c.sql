-- 1. Stop the store RPC from creating a second recovery plan (the sales trigger already does it, with name + correct rate)
CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise(p_catalog_id uuid, p_quantity integer, p_payment_mode text DEFAULT 'full'::text, p_size text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  v_size     text := NULLIF(btrim(COALESCE(p_size, '')), '');
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

  v_avail := COALESCE(public.get_user_available_balance(v_uid), 0);

  IF v_mode = 'full' THEN
    IF v_avail < v_total THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Your wallet has UGX % but this order needs UGX %', v_avail, v_total
        USING ERRCODE = 'P0001';
    END IF;
    v_down := v_total;
  ELSE
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
    order_status, payment_plan, selected_size
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, v_status,
    v_down, v_out, current_date, v_uid,
    (CASE WHEN v_mode = 'installment' AND v_down <= 0
      THEN 'Agent store - installment plan, zero wallet balance (25% wallet recovery)'
    WHEN v_mode = 'installment'
      THEN 'Agent store - installment plan (25% wallet recovery)'
      ELSE 'Agent store - instant wallet debit' END)
      || COALESCE(' | Size: ' || v_size, ''),
    'processing', v_mode, v_size
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
            'order_total', v_total,
            'selected_size', v_size
          )
        ),
        jsonb_build_object(
          'ledger_scope', 'platform',
          'direction', 'cash_in',
          'amount', v_down,
          'category', 'merchandise_revenue',
          'source_table', 'merchandise_sales',
          'source_id', v_sale_id,
          'description', 'Merchandise sale - ' || v_item.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'sale_id', v_sale_id,
            'catalog_id', v_item.id,
            'quantity', p_quantity,
            'payment_plan', v_mode,
            'selected_size', v_size
          )
        )
      )
    );
  END IF;

  -- NOTE: the recovery plan is created by trg_create_merchandise_recovery_plan
  -- on merchandise_sales (with customer name, phone and the correct daily rate).
  -- Inserting one here as well produced duplicate plans and double-counted exposure.

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'total', v_total,
    'paid_now', v_down,
    'outstanding', v_out,
    'payment_plan', v_mode,
    'selected_size', v_size
  );
END;
$fn$;

-- 2. Cancel duplicate plans (the nameless RPC-created twin), keeping the named trigger row
WITH ranked AS (
  SELECT p.id,
         row_number() OVER (
           PARTITION BY p.sale_id
           ORDER BY (p.customer_name IS NULL), (p.created_by IS NULL), p.created_at
         ) AS rn
  FROM public.merchandise_recovery_plans p
  WHERE p.sale_id IS NOT NULL
    AND p.status <> 'cancelled'
    AND NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_deductions d WHERE d.plan_id = p.id)
    AND (SELECT count(*) FROM public.merchandise_recovery_plans q
         WHERE q.sale_id = p.sale_id AND q.status <> 'cancelled') > 1
)
UPDATE public.merchandise_recovery_plans p
SET status = 'cancelled',
    updated_at = now()
FROM ranked r
WHERE r.id = p.id AND r.rn > 1;

-- 3. Backfill missing customer identity from profiles
UPDATE public.merchandise_recovery_plans p
SET customer_name = COALESCE(p.customer_name, pr.full_name),
    customer_phone = COALESCE(p.customer_phone, pr.phone),
    updated_at = now()
FROM public.profiles pr
WHERE pr.id = p.customer_id
  AND (p.customer_name IS NULL OR p.customer_phone IS NULL);

-- 4. Re-derive recovered / remaining / status strictly from recorded deductions
WITH agg AS (
  SELECT plan_id, sum(amount) AS rec, max(created_at) AS last_at
  FROM public.merchandise_recovery_deductions
  GROUP BY plan_id
)
UPDATE public.merchandise_recovery_plans p
SET amount_recovered = COALESCE(a.rec, 0),
    outstanding_balance = GREATEST(0, COALESCE(p.original_amount, 0) - COALESCE(a.rec, 0)),
    last_recovery_at = a.last_at,
    status = CASE
      WHEN p.status = 'cancelled' THEN 'cancelled'
      WHEN GREATEST(0, COALESCE(p.original_amount, 0) - COALESCE(a.rec, 0)) <= 0 THEN 'completed'
      ELSE 'active'
    END,
    updated_at = now()
FROM (SELECT id FROM public.merchandise_recovery_plans) x
LEFT JOIN agg a ON a.plan_id = x.id
WHERE p.id = x.id
  AND (p.amount_recovered <> COALESCE(a.rec, 0)
       OR p.outstanding_balance <> GREATEST(0, COALESCE(p.original_amount, 0) - COALESCE(a.rec, 0))
       OR COALESCE(p.last_recovery_at, 'epoch'::timestamptz) <> COALESCE(a.last_at, 'epoch'::timestamptz));

-- 5. Guard: at most one live recovery plan per sale
CREATE UNIQUE INDEX IF NOT EXISTS merchandise_recovery_plans_one_live_per_sale
  ON public.merchandise_recovery_plans (sale_id)
  WHERE sale_id IS NOT NULL AND status <> 'cancelled';