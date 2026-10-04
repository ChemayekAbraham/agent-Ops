CREATE OR REPLACE FUNCTION public.get_user_available_balance(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _wallet_balance numeric := 0;
  _ledger_net    numeric := 0;
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

  SELECT COALESCE(balance, 0) INTO _wallet_balance
  FROM public.wallets WHERE user_id = _user_id;

  SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0)
  INTO _ledger_net
  FROM public.general_ledger
  WHERE user_id = _user_id
    AND classification = 'production';

  _available := GREATEST(0, LEAST(_wallet_balance, _ledger_net));

  RETURN jsonb_build_object(
    'available', _available,
    'wallet_cached', _wallet_balance,
    'ledger_net', _ledger_net,
    'has_drift', _wallet_balance <> _ledger_net
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_available_balance(uuid) TO authenticated;