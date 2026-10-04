-- Compatibility overload: legacy parameter names → canonical function.
-- Some older DB functions and migrations call create_ledger_transaction
-- using p_transaction_group_id / p_entries. The canonical signature is
-- (entries jsonb, idempotency_key text, skip_balance_check bool). This
-- shim keeps all legacy callers working forever.
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(
  p_transaction_group_id uuid,
  p_entries jsonb,
  p_idempotency_key text DEFAULT NULL,
  p_skip_balance_check boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  -- Delegate to the canonical implementation. The transaction group id
  -- argument is intentionally ignored — the canonical function generates
  -- its own group id (and returns it). Legacy callers either discard the
  -- return value or use it for logging only, so this is safe.
  v_group_id := public.create_ledger_transaction(
    entries            => p_entries,
    idempotency_key    => p_idempotency_key,
    skip_balance_check => p_skip_balance_check
  );
  RETURN v_group_id;
END;
$$;