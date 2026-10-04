CREATE OR REPLACE FUNCTION public.issue_landlord_payout_receipt(
  p_payout_id uuid,
  p_processed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.landlord_payouts;
  v_existing public.landlord_payout_receipts;
  v_receipt public.landlord_payout_receipts;
  v_processor uuid;
  v_processor_name text;
  v_processor_role text;
  v_landlord_name text;
  v_tenant_name text;
  v_agent_name text;
  v_house public.house_listings;
  v_paid_at timestamptz;
  v_reference text;
  v_method text;
  v_snapshot jsonb;
  v_number text;
BEGIN
  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payout_not_found');
  END IF;

  SELECT * INTO v_existing FROM public.landlord_payout_receipts WHERE payout_id = p_payout_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'created', false,
      'receipt_id', v_existing.id,
      'receipt_code', v_existing.receipt_code,
      'receipt_number', v_existing.receipt_number,
      'sms_sent_at', v_existing.sms_sent_at,
      'landlord_phone', v_existing.landlord_phone,
      'snapshot', v_existing.snapshot
    );
  END IF;

  IF v_payout.status NOT IN ('awaiting_agent_receipt', 'completed')
     OR COALESCE(v_payout.disbursed_at, v_payout.finops_disbursed_at) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payout_not_confirmed', 'status', v_payout.status);
  END IF;

  v_paid_at := COALESCE(v_payout.disbursed_at, v_payout.finops_disbursed_at, now());
  v_processor := COALESCE(p_processed_by, v_payout.finops_disbursed_by);

  SELECT full_name INTO v_processor_name FROM public.profiles WHERE id = v_processor;
  IF EXISTS (SELECT 1 FROM public.cashout_agents WHERE agent_id = v_processor) THEN
    v_processor_role := 'Merchant Agent';
  ELSIF v_processor IS NOT NULL AND public.is_ops_role(v_processor) THEN
    v_processor_role := 'Financial Ops';
  ELSE
    v_processor_role := 'Welile Staff';
  END IF;

  -- landlord_payouts.landlord_id points at public.landlords (not profiles).
  SELECT COALESCE(v_payout.landlord_name, l.name) INTO v_landlord_name
  FROM public.landlords l WHERE l.id = v_payout.landlord_id;
  v_landlord_name := COALESCE(v_landlord_name, v_payout.landlord_name, 'Landlord');

  SELECT full_name INTO v_tenant_name FROM public.profiles WHERE id = v_payout.tenant_id;
  SELECT full_name INTO v_agent_name FROM public.profiles WHERE id = v_payout.agent_id;

  SELECT * INTO v_house
  FROM public.house_listings
  WHERE tenant_id = v_payout.tenant_id
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1;

  v_reference := COALESCE(v_payout.finops_momo_reference, v_payout.external_reference, '—');
  v_method := CASE
    WHEN v_payout.mobile_money_provider IS NOT NULL
      THEN 'Mobile Money (' || upper(v_payout.mobile_money_provider) || ')'
    ELSE 'Mobile Money'
  END;

  v_number := 'WLR-' || nextval('public.landlord_receipt_number_seq')::text;

  v_snapshot := jsonb_build_object(
    'receipt_number', v_number,
    'status', 'completed',
    'amount', v_payout.amount,
    'landlord_name', v_landlord_name,
    'tenant_name', COALESCE(v_tenant_name, 'Tenant'),
    'agent_name', v_agent_name,
    'rent_period', to_char(v_paid_at, 'FMMonth YYYY'),
    'house_type', COALESCE(v_house.house_category, 'Rental Unit'),
    'property_address', NULLIF(
      concat_ws(', ',
        NULLIF(v_house.address, ''),
        NULLIF(v_house.village, ''),
        NULLIF(v_house.sub_county, ''),
        NULLIF(v_house.district, '')
      ), ''),
    'paid_at', v_paid_at,
    'processed_by_name', COALESCE(v_processor_name, 'Welile Staff'),
    'processor_role', v_processor_role,
    'payment_method', v_method,
    'transaction_reference', v_reference
  );

  INSERT INTO public.landlord_payout_receipts (
    payout_id, receipt_number, amount, landlord_id, tenant_id, agent_id,
    processed_by, landlord_phone, snapshot, generated_by
  ) VALUES (
    p_payout_id, v_number, v_payout.amount, v_payout.landlord_id, v_payout.tenant_id,
    v_payout.agent_id, v_processor, v_payout.landlord_phone, v_snapshot, v_processor
  )
  ON CONFLICT (payout_id) DO NOTHING
  RETURNING * INTO v_receipt;

  IF v_receipt.id IS NULL THEN
    SELECT * INTO v_receipt FROM public.landlord_payout_receipts WHERE payout_id = p_payout_id;
    RETURN jsonb_build_object(
      'ok', true, 'created', false,
      'receipt_id', v_receipt.id,
      'receipt_code', v_receipt.receipt_code,
      'receipt_number', v_receipt.receipt_number,
      'sms_sent_at', v_receipt.sms_sent_at,
      'landlord_phone', v_receipt.landlord_phone,
      'snapshot', v_receipt.snapshot
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'created', true,
    'receipt_id', v_receipt.id,
    'receipt_code', v_receipt.receipt_code,
    'receipt_number', v_receipt.receipt_number,
    'sms_sent_at', NULL,
    'landlord_phone', v_receipt.landlord_phone,
    'snapshot', v_receipt.snapshot
  );
END;
$$;