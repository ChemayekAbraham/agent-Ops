CREATE OR REPLACE FUNCTION public.create_ledger_transaction_locked(
  entries jsonb,
  lock_user_id uuid,
  min_available numeric DEFAULT NULL,
  idempotency_key text DEFAULT NULL,
  skip_balance_check boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available numeric;
  v_group uuid;
BEGIN
  IF lock_user_id IS NULL THEN
    RAISE EXCEPTION 'lock_user_id is required';
  END IF;

  -- Serialise concurrent cross-bucket moves for this user for the rest of the tx.
  PERFORM pg_advisory_xact_lock(hashtext('bucket_reclass:' || lock_user_id::text));

  IF min_available IS NOT NULL THEN
    v_available := public.get_user_available_balance(lock_user_id);
    IF COALESCE(v_available, 0) < min_available THEN
      RAISE EXCEPTION 'Insufficient funds. Available: UGX %', COALESCE(v_available, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_group := public.create_ledger_transaction(
    entries := entries,
    idempotency_key := idempotency_key,
    skip_balance_check := skip_balance_check
  );

  RETURN v_group;
END;
$$;

REVOKE ALL ON FUNCTION public.create_ledger_transaction_locked(jsonb, uuid, numeric, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_ledger_transaction_locked(jsonb, uuid, numeric, text, boolean) TO service_role;