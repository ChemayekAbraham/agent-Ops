
-- 1. Update record_rent_request_repayment to also post a general_ledger entry for each repayment
CREATE OR REPLACE FUNCTION public.record_rent_request_repayment(p_tenant_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id uuid;
  v_total_repayment numeric;
  v_amount_repaid numeric;
  v_apply numeric;
  v_landlord_id uuid;
  v_landlord_name text;
BEGIN
  -- Find the tenant's active rent request (funded/disbursed/approved)
  SELECT rr.id, rr.total_repayment, rr.amount_repaid, rr.landlord_id, l.name
  INTO v_request_id, v_total_repayment, v_amount_repaid, v_landlord_id, v_landlord_name
  FROM public.rent_requests rr
  LEFT JOIN public.landlords l ON l.id = rr.landlord_id
  WHERE
    rr.tenant_id = p_tenant_id
    AND rr.status IN ('funded', 'disbursed', 'approved')
    AND rr.amount_repaid < rr.total_repayment
  ORDER BY rr.created_at DESC
  LIMIT 1;

  IF v_request_id IS NOT NULL THEN
    v_apply := LEAST(p_amount, v_total_repayment - v_amount_repaid);
    
    -- Update rent_requests amount_repaid
    UPDATE public.rent_requests
    SET
      amount_repaid = amount_repaid + v_apply,
      status = CASE WHEN (amount_repaid + v_apply) >= total_repayment THEN 'completed' ELSE status END,
      updated_at = now()
    WHERE id = v_request_id;

    -- Record the repayment
    INSERT INTO public.repayments (tenant_id, rent_request_id, amount)
    VALUES (p_tenant_id, v_request_id, v_apply);

    -- Also reduce landlord's rent_balance_due
    IF v_landlord_id IS NOT NULL THEN
      UPDATE public.landlords
      SET
        rent_balance_due = GREATEST(0, rent_balance_due - v_apply),
        rent_last_paid_at = now(),
        rent_last_paid_amount = v_apply
      WHERE id = v_landlord_id;
    END IF;

    -- Post ledger entry for the repayment (audit trail)
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, linked_party, reference_id
    ) VALUES (
      p_tenant_id,
      v_apply,
      'cash_in',
      'rent_repayment',
      'repayments',
      v_request_id,
      'Rent repayment - ' || COALESCE(v_landlord_name, 'landlord'),
      v_landlord_id::text,
      v_request_id::text
    );
  END IF;
END;
$$;

-- 2. Backfill: Insert obligation ledger entries for all existing active rent requests
-- that don't already have an obligation entry
INSERT INTO public.general_ledger (
  user_id, amount, direction, category, source_table, source_id,
  description, reference_id, transaction_date
)
SELECT
  rr.tenant_id,
  rr.total_repayment,
  'cash_out',
  'rent_obligation',
  'rent_requests',
  rr.id,
  'Rent obligation (backfill) - ' || COALESCE(l.name, 'landlord') || ' (' || rr.duration_days || ' days)',
  rr.id::text,
  COALESCE(rr.funded_at, rr.approved_at, rr.created_at)
FROM public.rent_requests rr
LEFT JOIN public.landlords l ON l.id = rr.landlord_id
WHERE rr.status IN ('funded', 'disbursed', 'approved', 'completed')
  AND rr.total_repayment > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger gl
    WHERE gl.user_id = rr.tenant_id
      AND gl.category = 'rent_obligation'
      AND gl.source_id = rr.id
  );

-- 3. Backfill: Insert repayment ledger entries for all existing repayments
-- that don't already have a ledger entry
INSERT INTO public.general_ledger (
  user_id, amount, direction, category, source_table, source_id,
  description, reference_id, transaction_date
)
SELECT
  rep.tenant_id,
  rep.amount,
  'cash_in',
  'rent_repayment',
  'repayments',
  rep.rent_request_id,
  'Rent repayment (backfill) - ' || COALESCE(l.name, 'landlord'),
  rep.rent_request_id::text,
  rep.created_at
FROM public.repayments rep
JOIN public.rent_requests rr ON rr.id = rep.rent_request_id
LEFT JOIN public.landlords l ON l.id = rr.landlord_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.general_ledger gl
  WHERE gl.user_id = rep.tenant_id
    AND gl.category = 'rent_repayment'
    AND gl.source_table = 'repayments'
    AND gl.transaction_date = rep.created_at
    AND gl.amount = rep.amount
);
