
-- Fix: Update record_rent_request_repayment to also reduce landlords.rent_balance_due
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
BEGIN
  -- Find the tenant's active rent request (funded/disbursed/approved)
  SELECT id, total_repayment, amount_repaid, landlord_id 
  INTO v_request_id, v_total_repayment, v_amount_repaid, v_landlord_id
  FROM public.rent_requests
  WHERE
    tenant_id = p_tenant_id
    AND status IN ('funded', 'disbursed', 'approved')
    AND amount_repaid < total_repayment
  ORDER BY created_at DESC
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
  END IF;
END;
$$;
