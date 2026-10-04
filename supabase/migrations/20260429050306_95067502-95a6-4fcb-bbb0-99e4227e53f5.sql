-- Strict ledger-backed available balance.
-- Replaces baseline-anchored cap with: min(cached withdrawable, max(0, wallet ledger net)) - pending holds.
CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _withdrawable_cached numeric := 0;
  _ledger_net_now      numeric := 0;
  _pending_holds       numeric := 0;
  _allowed_cap         numeric := 0;
  _available           numeric := 0;
BEGIN
  SELECT COALESCE(withdrawable_balance, 0)
    INTO _withdrawable_cached
  FROM public.wallets
  WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in'  THEN amount
                           WHEN direction = 'cash_out' THEN -amount
                           ELSE 0 END), 0)
    INTO _ledger_net_now
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production');

  SELECT COALESCE(SUM(amount), 0)
    INTO _pending_holds
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND status IN ('pending','requested','manager_approved','processing');

  -- Strict rule: ledger is truth. Negative ledger => 0.
  _allowed_cap := GREATEST(0, _ledger_net_now);

  _available := GREATEST(
    0,
    LEAST(COALESCE(_withdrawable_cached, 0), _allowed_cap) - COALESCE(_pending_holds, 0)
  );

  RETURN _available;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_available_balance(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_user_available_balance(uuid) IS
  'Strict ledger-backed withdrawable. available = max(0, min(wallets.withdrawable_balance, max(0, wallet_ledger_net)) - pending_holds). Cached wallet bucket can only REDUCE the figure, never increase it.';

-- Diagnostic view of accounts whose cached wallet bucket exceeds strict ledger-backed withdrawable.
CREATE OR REPLACE VIEW public.wallet_strict_drift_view
WITH (security_invoker = on) AS
WITH ledger_nets AS (
  SELECT user_id,
         SUM(CASE WHEN direction = 'cash_in'  THEN amount
                  WHEN direction = 'cash_out' THEN -amount
                  ELSE 0 END) AS ledger_net
  FROM public.general_ledger
  WHERE ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production')
  GROUP BY user_id
), holds AS (
  SELECT user_id, SUM(amount) AS pending_holds
  FROM public.withdrawal_requests
  WHERE status IN ('pending','requested','manager_approved','processing')
  GROUP BY user_id
)
SELECT w.user_id,
       p.full_name,
       p.phone,
       COALESCE(w.withdrawable_balance, 0)              AS cached_withdrawable,
       COALESCE(w.float_balance, 0)                     AS cached_float,
       COALESCE(w.advance_balance, 0)                   AS cached_advance,
       COALESCE(l.ledger_net, 0)                        AS wallet_ledger_net,
       COALESCE(h.pending_holds, 0)                     AS pending_holds,
       GREATEST(
         0,
         LEAST(COALESCE(w.withdrawable_balance, 0), GREATEST(0, COALESCE(l.ledger_net, 0)))
         - COALESCE(h.pending_holds, 0)
       ) AS strict_withdrawable,
       COALESCE(w.withdrawable_balance, 0)
         - GREATEST(
             0,
             LEAST(COALESCE(w.withdrawable_balance, 0), GREATEST(0, COALESCE(l.ledger_net, 0)))
             - COALESCE(h.pending_holds, 0)
           ) AS cached_overstatement
FROM public.wallets w
LEFT JOIN public.profiles p ON p.id = w.user_id
LEFT JOIN ledger_nets l ON l.user_id = w.user_id
LEFT JOIN holds h ON h.user_id = w.user_id;

REVOKE ALL ON public.wallet_strict_drift_view FROM PUBLIC;
GRANT SELECT ON public.wallet_strict_drift_view TO authenticated;

COMMENT ON VIEW public.wallet_strict_drift_view IS
  'Finance diagnostic: accounts whose cached wallet.withdrawable_balance exceeds the strict ledger-backed withdrawable. Use to plan CFO clamp/correction passes. SECURITY INVOKER + RLS on base tables restricts access.';
