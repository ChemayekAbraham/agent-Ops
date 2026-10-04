CREATE OR REPLACE FUNCTION public.enforce_minimum_withdrawal_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  available NUMERIC;
BEGIN
  IF NEW.status = 'pending' THEN
    -- Use the strict, ledger-backed source of truth (same RPC used by
    -- the wallet card UI and the approve-withdrawal edge function).
    -- Falls back to 0 if the RPC returns NULL.
    BEGIN
      available := COALESCE(public.get_user_available_balance(NEW.user_id), 0);
    EXCEPTION WHEN OTHERS THEN
      -- Defensive fallback: if the RPC errors for any reason, use the
      -- live withdrawable bucket cache rather than the stale `balance`
      -- column, so we never falsely block a legitimate withdrawal.
      SELECT COALESCE(withdrawable_balance, 0) INTO available
      FROM public.wallets
      WHERE user_id = NEW.user_id;
      available := COALESCE(available, 0);
    END;

    IF available < 5000 THEN
      RAISE EXCEPTION
        'Withdrawal blocked: Your withdrawable balance must be at least UGX 5,000 to submit a withdrawal request. Available: %',
        available;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;