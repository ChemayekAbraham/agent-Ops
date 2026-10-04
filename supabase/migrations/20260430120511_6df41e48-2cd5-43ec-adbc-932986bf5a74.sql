CREATE OR REPLACE FUNCTION public.resubmit_rejected_deposit(p_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row public.deposit_requests%ROWTYPE;
  v_old_reason text;
  v_old_audit jsonb;
  v_new_audit jsonb;
  v_history jsonb;
  v_payload_purpose text;
  v_safe_purpose public.deposit_purpose;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.deposit_requests
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deposit not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.user_id <> v_user THEN
    RAISE EXCEPTION 'Not allowed to resubmit this deposit' USING ERRCODE = '42501';
  END IF;

  IF v_row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected deposits can be resubmitted (current: %)', v_row.status
      USING ERRCODE = '22023';
  END IF;

  v_payload_purpose := NULLIF(btrim(p_payload->>'deposit_purpose'), '');
  v_safe_purpose := v_row.deposit_purpose;

  IF v_payload_purpose IS NOT NULL THEN
    SELECT e.enumlabel::public.deposit_purpose
    INTO v_safe_purpose
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'deposit_purpose'
      AND e.enumlabel = v_payload_purpose;

    IF v_safe_purpose IS NULL THEN
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      VALUES (
        'deposit_failed'::public.system_event_type,
        v_user,
        'deposit_requests',
        p_id,
        jsonb_build_object(
          'reason', 'invalid_deposit_purpose_on_resubmit',
          'raw_deposit_purpose', v_payload_purpose
        )
      );

      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
      VALUES (
        v_user,
        'deposit_resubmit_invalid_purpose',
        'deposit_requests',
        p_id::text,
        jsonb_build_object(
          'reason', 'Invalid deposit purpose rejected during resubmission',
          'raw_deposit_purpose', v_payload_purpose
        )
      );

      RAISE EXCEPTION 'Invalid deposit purpose: %', v_payload_purpose
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_old_reason := v_row.rejection_reason;
  v_old_audit  := COALESCE(v_row.purpose_audit, '{}'::jsonb);

  v_history := COALESCE(v_old_audit -> 'resubmissions', '[]'::jsonb);
  v_history := v_history || jsonb_build_object(
    'resubmitted_at', now(),
    'previous_amount', v_row.amount,
    'previous_transaction_id', v_row.transaction_id,
    'previous_provider', v_row.provider,
    'previous_deposit_purpose', v_row.deposit_purpose::text,
    'previous_rejection_reason', v_old_reason
  );

  v_new_audit := v_old_audit
    || jsonb_build_object(
         'last_resubmitted_at', now(),
         'last_resubmitted_by', v_user,
         'chosen_purpose', v_safe_purpose::text,
         'resubmissions', v_history
       );

  UPDATE public.deposit_requests
  SET
    amount           = COALESCE((p_payload->>'amount')::numeric, amount),
    transaction_id   = COALESCE(NULLIF(btrim(p_payload->>'transaction_id'), ''), transaction_id),
    provider         = COALESCE(NULLIF(btrim(p_payload->>'provider'), ''), provider),
    transaction_date = COALESCE((NULLIF(btrim(p_payload->>'transaction_date'), ''))::timestamptz, transaction_date),
    notes            = COALESCE(p_payload->>'notes', notes),
    deposit_purpose  = v_safe_purpose,
    purpose_audit    = v_new_audit,
    status           = 'pending',
    rejection_reason = NULL,
    updated_at       = now()
  WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_user,
    'deposit_resubmitted',
    'deposit_requests',
    p_id::text,
    jsonb_build_object(
      'reason', 'User resubmitted a previously rejected deposit',
      'previous_rejection_reason', v_old_reason,
      'new_amount', (p_payload->>'amount')::numeric,
      'new_transaction_id', p_payload->>'transaction_id',
      'deposit_purpose', v_safe_purpose::text
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'deposit_failed'::public.system_event_type,
    v_user,
    'deposit_requests',
    p_id,
    jsonb_build_object(
      'event_subtype', 'deposit.resubmitted',
      'previous_rejection_reason', v_old_reason,
      'deposit_purpose', v_safe_purpose::text
    )
  );

  RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_deposit_purpose_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.deposit_purpose IS NULL THEN
    NEW.deposit_purpose := 'other'::public.deposit_purpose;
  END IF;

  IF NEW.purpose_audit IS NULL OR jsonb_typeof(NEW.purpose_audit) <> 'object' THEN
    NEW.purpose_audit := '{}'::jsonb;
  END IF;

  IF NOT (NEW.purpose_audit ? 'chosen_purpose') THEN
    NEW.purpose_audit := NEW.purpose_audit || jsonb_build_object('chosen_purpose', NEW.deposit_purpose::text);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_deposit_purpose_before_write ON public.deposit_requests;
CREATE TRIGGER trg_normalize_deposit_purpose_before_write
BEFORE INSERT OR UPDATE OF deposit_purpose, purpose_audit ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.normalize_deposit_purpose_before_write();