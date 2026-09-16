-- Closes a real double-spend race in the withdrawable<->float bucket-reclass
-- path (agent-convert-withdrawable-to-float, admin-withdrawable-to-float,
-- admin-float-to-withdrawable, finops-wallet-move).
--
-- Those functions all set skip_balance_check := true when calling
-- create_ledger_transaction, because create_ledger_transaction's own
-- built-in availability check can't judge a cross-bucket move. Instead each
-- edge function does its own get_user_available_balance() read BEFORE
-- posting. Under READ COMMITTED, two concurrent conversions for the same
-- user (two devices, a client retry, a proxy caller) can both read the same
-- pre-move balance, both pass, and both post -- overdrawing withdrawable.
--
-- Root cause: no lock is held between the availability check and the write.
-- A prior attempt at a general fix (20260811062541_wallet_row_locking_race_fix.sql,
-- gated behind wallet_row_locking_rollout / wallet_row_locking_canary_users)
-- was never applied to production -- those tables/functions don't exist
-- live. Rather than resurrect that system-wide, feature-flagged mechanism
-- (whose deadlock/timeout risk across every ledger writer is exactly why it
-- shipped disabled), this adds a narrowly-scoped, unconditional advisory
-- lock just for the bucket-reclass operation family.
--
-- create_ledger_transaction_locked wraps the existing, unmodified
-- create_ledger_transaction: it takes a per-user advisory lock salted to
-- 'bucket_reclass' (so it never contends with unrelated ledger writes for
-- the same user), re-reads get_user_available_balance() while holding that
-- lock, and only then delegates to create_ledger_transaction. The lock
-- releases automatically at transaction end (pg_advisory_xact_lock), so a
-- second concurrent reclass for the same user blocks until the first one's
-- legs are committed and visible to the recheck.
CREATE OR REPLACE FUNCTION public.create_ledger_transaction_locked(
  entries jsonb,
  idempotency_key text DEFAULT NULL,
  skip_balance_check boolean DEFAULT false,
  lock_user_id uuid DEFAULT NULL,
  min_available numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_available numeric;
BEGIN
  IF lock_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('bucket_reclass:' || lock_user_id::text));
  END IF;

  IF lock_user_id IS NOT NULL AND min_available IS NOT NULL THEN
    v_available := COALESCE(public.get_user_available_balance(lock_user_id), 0);
    IF v_available < min_available THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: user % has UGX % available, UGX % required',
        lock_user_id, v_available, min_available
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_group_id := public.create_ledger_transaction(
    entries            => create_ledger_transaction_locked.entries,
    idempotency_key    => create_ledger_transaction_locked.idempotency_key,
    skip_balance_check => create_ledger_transaction_locked.skip_balance_check
  );

  RETURN v_group_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_ledger_transaction_locked(jsonb, text, boolean, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_ledger_transaction_locked(jsonb, text, boolean, uuid, numeric) TO service_role;

COMMENT ON FUNCTION public.create_ledger_transaction_locked(jsonb, text, boolean, uuid, numeric) IS
  'Lock-then-post wrapper around create_ledger_transaction for the withdrawable<->float bucket-reclass family. Takes an advisory lock salted to "bucket_reclass:<user>" and re-validates get_user_available_balance() under that lock before posting, closing the TOCTOU race that skip_balance_check leaves open for concurrent cross-bucket moves. Service-role only.';
