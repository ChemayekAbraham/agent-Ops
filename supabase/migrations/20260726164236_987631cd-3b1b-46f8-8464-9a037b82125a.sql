-- 1. Add gallery images column (max 2) to merchandise_catalog
ALTER TABLE public.merchandise_catalog
  ADD COLUMN IF NOT EXISTS image_urls text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.merchandise_catalog
  DROP CONSTRAINT IF EXISTS merchandise_catalog_image_urls_max;
ALTER TABLE public.merchandise_catalog
  ADD CONSTRAINT merchandise_catalog_image_urls_max
    CHECK (array_length(image_urls, 1) IS NULL OR array_length(image_urls, 1) <= 2);

-- 2. Storage RLS on `merchandise` bucket
DROP POLICY IF EXISTS "Merchandise images readable by authenticated" ON storage.objects;
CREATE POLICY "Merchandise images readable by authenticated"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'merchandise');

DROP POLICY IF EXISTS "Merchandise images managed by leadership" ON storage.objects;
CREATE POLICY "Merchandise images managed by leadership"
  ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'merchandise' AND (
      has_role(auth.uid(), 'cmo'::app_role)
      OR has_role(auth.uid(), 'manager'::app_role)
      OR has_role(auth.uid(), 'super_admin'::app_role)
    )
  )
  WITH CHECK (
    bucket_id = 'merchandise' AND (
      has_role(auth.uid(), 'cmo'::app_role)
      OR has_role(auth.uid(), 'manager'::app_role)
      OR has_role(auth.uid(), 'super_admin'::app_role)
    )
  );

-- 3. Instant-purchase RPC — debits withdrawable wallet immediately, raises on insufficient funds
CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise(
  p_catalog_id uuid,
  p_quantity integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_item    record;
  v_total   numeric;
  v_avail   numeric;
  v_name    text;
  v_phone   text;
  v_sale_id uuid;
  v_tid     uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
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

  v_avail := COALESCE(public.get_user_available_balance(v_uid), 0);
  IF v_avail < v_total THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Your wallet has UGX % but this order needs UGX %', v_avail, v_total
      USING ERRCODE = 'P0001';
  END IF;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes, order_status
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, 'paid',
    v_total, 0, current_date, v_uid, 'Agent store — instant wallet debit', 'processing'
  ) RETURNING id INTO v_sale_id;

  PERFORM public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'wallet',
        'direction', 'cash_out',
        'amount', v_total,
        'category', 'wallet_deduction',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_sales',
        'source_id', v_sale_id,
        'description', 'Merchandise Purchase – ' || v_item.item_name,
        'currency', 'UGX',
        'metadata', jsonb_build_object(
          'source', 'merchandise_instant_purchase',
          'sale_id', v_sale_id,
          'catalog_id', v_item.id,
          'quantity', p_quantity
        )
      ),
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'platform',
        'direction', 'cash_in',
        'amount', v_total,
        'category', 'debt_recovery',
        'recipient_type', 'operational_wallet',
        'source_table', 'merchandise_sales',
        'source_id', v_sale_id,
        'description', 'Merchandise Sale – ' || v_item.item_name,
        'currency', 'UGX',
        'metadata', jsonb_build_object(
          'source', 'merchandise_instant_purchase',
          'sale_id', v_sale_id,
          'catalog_id', v_item.id,
          'item_name', v_item.item_name,
          'quantity', p_quantity
        )
      )
    ),
    idempotency_key => 'merch_purchase_' || v_sale_id::text,
    skip_balance_check => false
  );

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'item', v_item.item_name,
    'quantity', p_quantity,
    'total', v_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_purchase_merchandise(uuid, integer) TO authenticated;