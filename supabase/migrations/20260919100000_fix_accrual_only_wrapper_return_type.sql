-- ============================================================================
-- FIX: create_ledger_transaction_accrual_only — return type regression
-- ============================================================================
--
-- ── The regression ──────────────────────────────────────────────────────────
--
-- The wrapper was written on 2026-05-15, when create_ledger_transaction still
-- returned jsonb. On 2026-09-14 (migration 20260914180000_adversarial_
-- regression_fixes) that function was changed to RETURNS uuid. The wrapper was
-- not updated and still declares:
--
--     DECLARE v_result jsonb;
--     SELECT public.create_ledger_transaction(entries) INTO v_result;
--
-- Assigning a uuid into a jsonb variable makes Postgres parse the UUID text as
-- JSON, which fails on the first token:
--
--     ERROR 22P02: invalid input syntax for type json
--     DETAIL: Token "5de92d3c" is invalid.
--
-- The failure occurs AFTER create_ledger_transaction has inserted its legs, so
-- the statement aborts and the whole transaction rolls back. No data is
-- corrupted, but the wrapper can never succeed: every caller of the wallet-safe
-- accrual path has been failing since 14 September.
--
-- Confirmed against production:
--   create_ledger_transaction(jsonb, text, boolean)        -> uuid
--   create_ledger_transaction(uuid, jsonb, text, boolean)  -> uuid
--   create_ledger_transaction_accrual_only(jsonb)          -> jsonb  (declares jsonb internally)
--
-- ── Why the signature is kept as jsonb ──────────────────────────────────────
--
-- The only caller is supabase/functions/auto-charge-wallets/index.ts, which
-- reads just the error and discards the payload:
--
--     const { error: accrualErr } = await supabase.rpc(
--       "create_ledger_transaction_accrual_only", { entries: accrualEntries });
--
-- Nothing consumes the return value, and no database function calls this
-- wrapper. Changing RETURNS jsonb to RETURNS uuid would therefore be safe for
-- callers but would require DROP + CREATE (Postgres cannot change a return type
-- via CREATE OR REPLACE), which would drop the EXECUTE grants, briefly remove
-- the function from the API surface, and force a regeneration of the committed
-- schema-types fingerprint.
--
-- Keeping jsonb avoids all of that. The group id is returned inside a small
-- object so the value is self-describing if a caller ever does read it.
--
-- ── What is deliberately NOT changed ────────────────────────────────────────
--
--   * create_ledger_transaction — untouched, both overloads, behaviour intact.
--   * assert_no_wallet_ledger_entries — untouched; still called first, so a
--     wallet-scoped leg is still rejected before anything is posted.
--   * The transaction-local wallet.accrual_lock — still set, so cascading
--     triggers that try to mutate wallet buckets are still refused by
--     enforce_wallet_ledger_only.
--   * SECURITY DEFINER, search_path, argument name and type, grants — all
--     preserved exactly.
--   * No wallet, withdrawal, tenant repayment or accounting-category logic is
--     touched. No financial row is read, written or modified by this migration.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_ledger_transaction_accrual_only(entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- FIXED: create_ledger_transaction returns uuid, not jsonb. Holding the
  -- result in a uuid and converting on return is what removes the 22P02.
  v_group_id uuid;
BEGIN
  -- 1. Refuse any wallet-scoped leg in the payload. Unchanged, and still the
  --    first thing that happens, so a bad payload is rejected before posting.
  PERFORM public.assert_no_wallet_ledger_entries(entries);

  -- 2. Engage the wallet write lock for THIS transaction only.
  --    `set_config(..., true)` makes it transaction-local, so it auto-clears
  --    on COMMIT/ROLLBACK and cannot leak to other PostgREST requests sharing
  --    the same physical connection. Unchanged.
  PERFORM set_config('wallet.accrual_lock', 'on', true);

  -- 3. Forward to the canonical ledger posting function.
  --    Any cascading trigger that attempts to mutate wallet buckets will be
  --    rejected by enforce_wallet_ledger_only because the lock is on.
  --    Unchanged, other than receiving the uuid into a uuid.
  v_group_id := public.create_ledger_transaction(entries);

  RETURN jsonb_build_object('transaction_group_id', v_group_id);
END;
$function$;

-- Grants restated to match the original definition. CREATE OR REPLACE preserves
-- existing privileges, so these are idempotent and present only to keep the
-- intended access explicit in one place.
GRANT EXECUTE ON FUNCTION public.create_ledger_transaction_accrual_only(jsonb)
  TO service_role, authenticated;

COMMENT ON FUNCTION public.create_ledger_transaction_accrual_only(jsonb) IS
  'Wallet-safe ledger posting. Rejects any wallet-scoped leg, sets the transaction-local wallet.accrual_lock, then forwards to create_ledger_transaction. Returns {"transaction_group_id": <uuid>}. Fixed 2026-09-19: the wrapper previously assigned the uuid result into a jsonb variable, raising 22P02 and rolling back every accrual posting since 2026-09-14.';
