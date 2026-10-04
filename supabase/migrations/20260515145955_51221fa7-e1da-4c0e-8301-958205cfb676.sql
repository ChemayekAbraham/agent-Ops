CREATE OR REPLACE FUNCTION public.create_ledger_transaction_accrual_only(entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- 1. Refuse any wallet-scoped leg in the payload.
  PERFORM public.assert_no_wallet_ledger_entries(entries);

  -- 2. Engage the wallet write lock for THIS transaction only.
  --    `set_config(..., true)` makes it transaction-local, so it auto-clears
  --    on COMMIT/ROLLBACK and cannot leak to other PostgREST requests sharing
  --    the same physical connection.
  PERFORM set_config('wallet.accrual_lock', 'on', true);

  -- 3. Forward to the canonical ledger posting function.
  --    Any cascading trigger that attempts to mutate wallet buckets will be
  --    rejected by enforce_wallet_ledger_only because the lock is on.
  SELECT public.create_ledger_transaction(entries) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_ledger_transaction_accrual_only(jsonb)
  TO service_role, authenticated;