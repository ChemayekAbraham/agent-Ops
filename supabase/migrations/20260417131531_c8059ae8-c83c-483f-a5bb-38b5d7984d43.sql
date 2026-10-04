CREATE OR REPLACE FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ledger_balance numeric;
BEGIN
  -- Only platform leadership can reconcile wallet caches
  IF NOT (
    has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient privileges to reconcile wallet';
  END IF;

  SELECT COALESCE(
    SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),
    0
  )
  INTO v_ledger_balance
  FROM general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet';

  -- Bypass the direct-mutation guard via session flag
  PERFORM set_config('app.bypass_wallet_guard', 'true', true);
  UPDATE wallets
  SET balance = v_ledger_balance,
      updated_at = now()
  WHERE user_id = p_user_id;
  PERFORM set_config('app.bypass_wallet_guard', 'false', true);

  RETURN v_ledger_balance;
END;
$$;