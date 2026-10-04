CREATE OR REPLACE FUNCTION public.get_user_available_balance(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _withdrawable  numeric := 0;
  _ledger_net    numeric := 0;
  _pending_holds numeric := 0;
  _available     numeric := 0;
BEGIN
  IF auth.uid() IS NULL OR (
    auth.uid() <> _user_id
    AND NOT (
      public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'operations')
    )
  ) THEN
    RAISE EXCEPTION 'insufficient_privileges';
  END IF;

  -- Withdrawable bucket only (float and advance can never fund payouts)
  SELECT COALESCE(withdrawable_balance, 0) INTO _withdrawable
  FROM public.wallets WHERE user_id = _user_id;

  -- Ledger net using correct directions cash_in / cash_out, scoped to wallet,
  -- including production rows (classification NULL or 'production').
  SELECT COALESCE(SUM(
    CASE
      WHEN direction = 'cash_in'  THEN amount
      WHEN direction = 'cash_out' THEN -amount
      ELSE 0
    END
  ), 0)
  INTO _ledger_net
  FROM public.general_ledger
  WHERE user_id = _user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production');

  -- Subtract money already queued in pending withdrawal requests so it can't
  -- be double-spent.
  SELECT COALESCE(SUM(amount), 0) INTO _pending_holds
  FROM public.withdrawal_requests
  WHERE user_id = _user_id
    AND status IN ('pending', 'requested', 'manager_approved', 'processing');

  _available := GREATEST(0, LEAST(_withdrawable, _ledger_net) - _pending_holds);

  RETURN jsonb_build_object(
    'available', _available,
    'wallet_cached', _withdrawable,
    'withdrawable_cached', _withdrawable,
    'ledger_net', _ledger_net,
    'pending_holds', _pending_holds,
    'has_drift', _withdrawable <> _ledger_net
  );
END;
$function$;