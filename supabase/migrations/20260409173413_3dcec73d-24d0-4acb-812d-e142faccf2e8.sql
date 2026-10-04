
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
  v_group_id uuid := gen_random_uuid();
BEGIN
  -- Only process successful or partial collections
  IF NEW.status NOT IN ('success', 'partial', 'agent_covered_72h', 'partial_agent_covered_72h', 'agent_direct_no_smartphone', 'agent_retry_success_no_smartphone') THEN
    RETURN NEW;
  END IF;

  -- DETERMINISTIC IDEMPOTENCY GUARD: If bridge entries already exist for this record, skip.
  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE source_table = 'subscription_charge_logs'
      AND source_id = NEW.id::text
      AND ledger_scope = 'bridge'
  ) THEN
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

  -- Total collected
  v_total := COALESCE(NEW.amount_deducted, 0);
  IF v_total <= 0 THEN
    RETURN NEW;
  END IF;

  -- Calculate principal share proportionally
  v_rent_share := ROUND(v_total * (COALESCE(v_rr.rent_amount, 0) / v_rr.total_repayment));

  -- BRIDGE: Reduce receivable for the principal portion (no cash movement, just accounting)
  IF v_rent_share > 0 THEN
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, linked_party, transaction_date, ledger_scope, transaction_group_id
    ) VALUES (
      NEW.tenant_id, v_rent_share, 'cash_out', 'rent_principal_collected',
      'subscription_charge_logs', NEW.id::text,
      'Receivable reduction from daily collection',
      'tenant', now(), 'bridge', v_group_id
    );
  END IF;

  RETURN NEW;
END;
$function$;
