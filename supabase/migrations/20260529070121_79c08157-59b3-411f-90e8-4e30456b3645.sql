CREATE OR REPLACE FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_balance numeric;
  v_caller uuid := auth.uid();
BEGIN
  -- Allow trusted system / service-role context (auth.uid() IS NULL), e.g.
  -- the cfo-direct-credit edge function which invokes this via the admin
  -- client. Otherwise require finance leadership.
  IF v_caller IS NOT NULL AND NOT (
    has_role(v_caller, 'cfo'::app_role)
    OR has_role(v_caller, 'coo'::app_role)
    OR has_role(v_caller, 'super_admin'::app_role)
    OR has_role(v_caller, 'manager'::app_role)
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

  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE wallets
  SET balance = v_ledger_balance,
      updated_at = now()
  WHERE user_id = p_user_id;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  RETURN v_ledger_balance;
END;
$function$;