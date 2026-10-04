-- Fix #1: validate_operational_float_allocations
CREATE OR REPLACE FUNCTION public.validate_operational_float_allocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix CONSTANT text := '[ALLOCATIONS]';
  v_idx int;
  v_raw text;
  v_payload jsonb;
  v_sum numeric := 0;
  v_count int := 0;
  v_tolerance CONSTANT numeric := 1;
BEGIN
  IF NEW.deposit_purpose IS DISTINCT FROM 'operational_float'::deposit_purpose THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.notes IS NULL THEN
    RAISE EXCEPTION 'Operational Float deposits require a per-tenant allocation breakdown'
      USING ERRCODE = 'check_violation';
  END IF;

  v_idx := position(v_prefix IN NEW.notes);
  IF v_idx = 0 THEN
    RAISE EXCEPTION 'Operational Float deposits require a per-tenant allocation breakdown'
      USING ERRCODE = 'check_violation';
  END IF;

  v_raw := btrim(substring(NEW.notes FROM v_idx + length(v_prefix)));

  BEGIN
    v_payload := v_raw::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Operational Float allocation payload is malformed JSON'
      USING ERRCODE = 'check_violation';
  END;

  IF jsonb_typeof(v_payload) <> 'array' THEN
    RAISE EXCEPTION 'Operational Float allocation payload must be a JSON array'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    COALESCE(SUM((elem->>'a')::numeric), 0),
    COUNT(*)
  INTO v_sum, v_count
  FROM jsonb_array_elements(v_payload) AS elem
  WHERE COALESCE(elem->>'tid', '') <> '';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Operational Float deposits require at least one tenant allocation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF abs(v_sum - NEW.amount) > v_tolerance THEN
    RAISE EXCEPTION
      'Operational Float allocations (UGX %) must equal deposit amount (UGX %) within % UGX (off by UGX %)',
      v_sum, NEW.amount, v_tolerance, abs(v_sum - NEW.amount)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- Fix #2: log_operational_float_breakdown_change
CREATE OR REPLACE FUNCTION public.log_operational_float_breakdown_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prev_alloc jsonb;
  v_new_alloc jsonb;
  v_changed text[] := ARRAY[]::text[];
  v_actor uuid;
  v_new_is_float boolean;
  v_old_is_float boolean;
BEGIN
  v_new_is_float := NEW.deposit_purpose IS NOT DISTINCT FROM 'operational_float'::deposit_purpose;
  v_old_is_float := TG_OP <> 'INSERT'
    AND OLD.deposit_purpose IS NOT DISTINCT FROM 'operational_float'::deposit_purpose;

  IF NOT v_new_is_float AND NOT v_old_is_float THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  v_new_alloc := public.extract_operational_float_allocations(NEW.notes);

  IF TG_OP = 'INSERT' THEN
    v_actor := COALESCE(auth.uid(), NEW.user_id);
    INSERT INTO public.operational_float_audit_log(
      deposit_request_id, transaction_id, action, changed_by,
      previous_amount, new_amount,
      previous_allocations, new_allocations,
      changed_fields, source
    ) VALUES (
      NEW.id, NEW.transaction_id, 'created', v_actor,
      NULL, NEW.amount,
      NULL, v_new_alloc,
      ARRAY['created'], 'insert'
    );
    RETURN NEW;
  END IF;

  v_prev_alloc := public.extract_operational_float_allocations(OLD.notes);

  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    v_changed := array_append(v_changed, 'amount');
  END IF;
  IF v_new_alloc IS DISTINCT FROM v_prev_alloc THEN
    v_changed := array_append(v_changed, 'allocations');
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    v_changed := array_append(v_changed, 'transaction_id');
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  v_actor := COALESCE(auth.uid(), NEW.user_id);

  INSERT INTO public.operational_float_audit_log(
    deposit_request_id, transaction_id, action, changed_by,
    previous_amount, new_amount,
    previous_allocations, new_allocations,
    changed_fields, source
  ) VALUES (
    NEW.id, NEW.transaction_id, 'edited', v_actor,
    OLD.amount, NEW.amount,
    v_prev_alloc, v_new_alloc,
    v_changed, 'update'
  );

  RETURN NEW;
END;
$function$;

-- Cleanup: reverse phantom credits + close stuck pending rows
DO $$
DECLARE
  v_user_b4d uuid := 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c';
  v_dr_71 uuid := '71809fb3-6af5-48cd-a0c0-531a7c7e3764';
  v_dr_7c uuid := '7c557c05-1eb2-4adb-9e55-530fda2a57ee';
  v_phantom_71 numeric := 2000000;
  v_phantom_7c numeric := 1000000;
  v_now timestamptz := now();
BEGIN
  PERFORM create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('user_id', v_user_b4d::text, 'amount', v_phantom_71, 'direction', 'cash_out', 'category', 'system_balance_correction', 'ledger_scope', 'wallet', 'source_table', 'deposit_requests', 'source_id', v_dr_71::text, 'reference_id', 'PHANTOM-REVERSAL-MP40229095694', 'description', 'Reverse phantom 2,000,000 UGX from triple-credited deposit MP40229095694', 'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('amount', v_phantom_71, 'direction', 'cash_in', 'category', 'system_balance_correction', 'ledger_scope', 'platform', 'source_table', 'deposit_requests', 'source_id', v_dr_71::text, 'description', 'Platform liability returned: phantom credit reversal MP40229095694', 'currency', 'UGX', 'transaction_date', v_now)
    )
  );

  PERFORM create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('user_id', v_user_b4d::text, 'amount', v_phantom_7c, 'direction', 'cash_out', 'category', 'system_balance_correction', 'ledger_scope', 'wallet', 'source_table', 'deposit_requests', 'source_id', v_dr_7c::text, 'reference_id', 'PHANTOM-REVERSAL-MP40227807112', 'description', 'Reverse phantom 1,000,000 UGX from triple-credited deposit MP40227807112', 'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('amount', v_phantom_7c, 'direction', 'cash_in', 'category', 'system_balance_correction', 'ledger_scope', 'platform', 'source_table', 'deposit_requests', 'source_id', v_dr_7c::text, 'description', 'Platform liability returned: phantom credit reversal MP40227807112', 'currency', 'UGX', 'transaction_date', v_now)
    )
  );

  UPDATE deposit_requests
  SET status = 'approved',
      approved_at = COALESCE(approved_at, v_now),
      processed_by = COALESCE(processed_by, v_user_b4d),
      notes = COALESCE(notes, '') || E'\n[CLEANUP 2026-04-27] Status reconciled after triple-credit incident; phantom credits reversed via balance_correction.'
  WHERE id IN (v_dr_71, v_dr_7c)
    AND status = 'pending';

  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES
    (v_user_b4d, 'phantom_credit_reversed', 'deposit_requests', v_dr_71,
     jsonb_build_object('transaction_id', 'MP40229095694', 'intended_amount', 1000000, 'total_credited_before', 3000000, 'phantom_reversed', v_phantom_71, 'final_wallet_credit', 1000000, 'reason', 'Trigger enum coalesce bug caused silent UPDATE failures; operator re-clicked twice')),
    (v_user_b4d, 'phantom_credit_reversed', 'deposit_requests', v_dr_7c,
     jsonb_build_object('transaction_id', 'MP40227807112', 'intended_amount', 500000, 'total_credited_before', 1500000, 'phantom_reversed', v_phantom_7c, 'final_wallet_credit', 500000, 'reason', 'Trigger enum coalesce bug caused silent UPDATE failures; operator re-clicked twice'));
END $$;
