
-- 1. Create the proportional revenue recognition trigger function
CREATE OR REPLACE FUNCTION public.sync_collection_to_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_charge RECORD;
  v_rr RECORD;
  v_total numeric;
  v_rent_share numeric;
  v_access_share numeric;
  v_request_share numeric;
  v_group_id uuid := gen_random_uuid();
BEGIN
  -- Only process successful or partial collections
  IF NEW.status NOT IN ('success', 'partial', 'agent_covered_72h', 'partial_agent_covered_72h') THEN
    RETURN NEW;
  END IF;

  -- Look up the subscription charge to get rent_request_id
  SELECT * INTO v_charge FROM public.subscription_charges WHERE id = NEW.subscription_id;
  IF v_charge IS NULL OR v_charge.rent_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get the rent request fee breakdown
  SELECT rent_amount, access_fee, request_fee, total_repayment
  INTO v_rr FROM public.rent_requests WHERE id = v_charge.rent_request_id;

  IF v_rr IS NULL OR v_rr.total_repayment IS NULL OR v_rr.total_repayment <= 0 THEN
    RETURN NEW;
  END IF;

  -- Total collected = amount deducted from tenant wallet
  v_total := COALESCE(NEW.amount_deducted, 0);
  IF v_total <= 0 THEN
    RETURN NEW;
  END IF;

  -- Calculate proportional shares
  v_rent_share := ROUND(v_total * (COALESCE(v_rr.rent_amount, 0) / v_rr.total_repayment));
  v_access_share := ROUND(v_total * (COALESCE(v_rr.access_fee, 0) / v_rr.total_repayment));
  -- Registration/request fee absorbs rounding remainder
  v_request_share := v_total - v_rent_share - v_access_share;

  -- Insert proportional ledger entries
  IF v_rent_share > 0 THEN
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, linked_party, transaction_date, ledger_scope, transaction_group_id
    ) VALUES (
      NEW.tenant_id, v_rent_share, 'cash_in', 'rent_principal_collected',
      'subscription_charge_logs', NEW.id,
      'Proportional rent principal from daily collection',
      'tenant', now(), 'platform', v_group_id
    );
  END IF;

  IF v_access_share > 0 THEN
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, linked_party, transaction_date, ledger_scope, transaction_group_id
    ) VALUES (
      NEW.tenant_id, v_access_share, 'cash_in', 'access_fee_collected',
      'subscription_charge_logs', NEW.id,
      'Proportional access fee from daily collection',
      'platform', now(), 'platform', v_group_id
    );
  END IF;

  IF v_request_share > 0 THEN
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, linked_party, transaction_date, ledger_scope, transaction_group_id
    ) VALUES (
      NEW.tenant_id, v_request_share, 'cash_in', 'registration_fee_collected',
      'subscription_charge_logs', NEW.id,
      'Proportional registration fee from daily collection',
      'platform', now(), 'platform', v_group_id
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. Attach trigger to subscription_charge_logs
DROP TRIGGER IF EXISTS trg_sync_collection_to_ledger ON public.subscription_charge_logs;
CREATE TRIGGER trg_sync_collection_to_ledger
  AFTER INSERT ON public.subscription_charge_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_collection_to_ledger();

-- 3. Update record_rent_request_repayment to remove the manual ledger insert
-- (the trigger now handles proportional ledger entries)
CREATE OR REPLACE FUNCTION public.record_rent_request_repayment(
  p_tenant_id uuid,
  p_amount numeric,
  p_transaction_group_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

    -- Reduce landlord's rent_balance_due
    IF v_landlord_id IS NOT NULL THEN
      UPDATE public.landlords
      SET
        rent_balance_due = GREATEST(0, rent_balance_due - v_apply),
        rent_last_paid_at = now(),
        rent_last_paid_amount = v_apply
      WHERE id = v_landlord_id;
    END IF;

    -- NOTE: Ledger entry removed — handled by sync_collection_to_ledger trigger
  END IF;
END;
$function$;
