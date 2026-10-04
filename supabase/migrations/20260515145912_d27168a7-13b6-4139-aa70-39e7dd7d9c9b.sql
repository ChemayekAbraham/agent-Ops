CREATE OR REPLACE FUNCTION public.begin_wallet_accrual_lock()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('wallet.accrual_lock', 'on', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.end_wallet_accrual_lock()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('wallet.accrual_lock', 'off', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.begin_wallet_accrual_lock() TO service_role;
GRANT EXECUTE ON FUNCTION public.end_wallet_accrual_lock()   TO service_role;

CREATE OR REPLACE FUNCTION public.assert_no_wallet_ledger_entries(p_entries jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_bad int;
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_entries) e
  WHERE lower(coalesce(e->>'ledger_scope','')) = 'wallet';

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'Accrual/backfill job attempted to post % wallet-scoped ledger leg(s); wallets must not be touched in this code path.',
      v_bad
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_no_wallet_ledger_entries(jsonb) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_wallet_ledger_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF OLD.balance              IS NOT DISTINCT FROM NEW.balance
 AND OLD.withdrawable_balance IS NOT DISTINCT FROM NEW.withdrawable_balance
 AND OLD.float_balance        IS NOT DISTINCT FROM NEW.float_balance
 AND OLD.advance_balance      IS NOT DISTINCT FROM NEW.advance_balance THEN
    RETURN NEW;
  END IF;

  -- HARD GUARD: accrual / backfill jobs forbid ALL wallet mutations,
  -- even via the normally-trusted apply_wallet_movement path.
  IF current_setting('wallet.accrual_lock', true) = 'on' THEN
    RAISE EXCEPTION
      'Wallet bucket mutation forbidden: wallet.accrual_lock is ON for this session (grace accrual / backfill job). user_id=%, balance % -> %, withdrawable % -> %, float % -> %, advance % -> %',
      NEW.user_id,
      OLD.balance, NEW.balance,
      OLD.withdrawable_balance, NEW.withdrawable_balance,
      OLD.float_balance, NEW.float_balance,
      OLD.advance_balance, NEW.advance_balance
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF current_setting('wallet.sync_authorized', true) = 'true' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Wallet bucket mutation forbidden. Use create_ledger_transaction; balances are derived from the ledger only. (changed: balance % -> %, withdrawable % -> %, float % -> %, advance % -> %)',
    OLD.balance, NEW.balance,
    OLD.withdrawable_balance, NEW.withdrawable_balance,
    OLD.float_balance, NEW.float_balance,
    OLD.advance_balance, NEW.advance_balance;
END;
$function$;