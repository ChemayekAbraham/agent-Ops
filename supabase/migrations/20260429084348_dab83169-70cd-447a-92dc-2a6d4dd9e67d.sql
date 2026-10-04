-- ============================================================
-- Withdrawable strict-rule v3: exclude float-bucket categories
-- ============================================================
-- Float-bucket categories live on ledger_scope='wallet' for accounting
-- purposes but represent company money flowing through float, not the
-- agent's own withdrawable funds. They must not drag down withdrawable.

CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _withdrawable_cached numeric := 0;
  _ledger_net_now      numeric := 0;
  _pending_holds       numeric := 0;
  _allowed_cap         numeric := 0;
  _available           numeric := 0;
  _anchor_at           timestamptz;
BEGIN
  SELECT COALESCE(withdrawable_balance, 0)
    INTO _withdrawable_cached
  FROM public.wallets
  WHERE user_id = p_user_id;

  SELECT anchor_at INTO _anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id;

  -- v3: exclude float-bucket categories from withdrawable computation.
  -- These hit ledger_scope='wallet' but belong to the float bucket,
  -- not the agent's own withdrawable funds.
  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in'  THEN amount
                           WHEN direction = 'cash_out' THEN -amount
                           ELSE 0 END), 0)
    INTO _ledger_net_now
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production')
    AND (_anchor_at IS NULL OR created_at >= _anchor_at)
    AND category NOT IN (
      'agent_float_deposit',
      'agent_float_used_for_rent',
      'agent_float_settlement',
      'partner_funding'
    );

  SELECT COALESCE(SUM(amount), 0)
    INTO _pending_holds
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND status IN ('pending','requested','manager_approved','processing');

  _allowed_cap := GREATEST(0, _ledger_net_now);

  _available := GREATEST(
    0,
    LEAST(COALESCE(_withdrawable_cached, 0), _allowed_cap) - COALESCE(_pending_holds, 0)
  );

  RETURN _available;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_user_available_balance(uuid) TO authenticated;