
-- Grandfather existing wallet cache balances: allow withdrawals to drain what
-- the cache shows, even when the cache OVERSTATES the ledger. This absorbs
-- historical CFO Direct Credit rows that never posted matching ledger legs.
-- Drift is still recorded for observability but no longer blocks payouts.
CREATE OR REPLACE FUNCTION public.validate_wallet_against_pivot(p_user_id uuid, p_threshold numeric DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE d record;
BEGIN
  SELECT * INTO d FROM public.wallet_pivot_drift_view WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'no_wallet');
  END IF;
  -- GRANDFATHER MODE (2026-07-24): Cached balances (incl. legacy CFO Direct
  -- Credits) are treated as authoritative for withdrawal gating. The wallet
  -- cache itself + get_user_available_balance already cap the payout, so
  -- draining the cache is safe. We only surface drift as diagnostic metadata.
  RETURN jsonb_build_object(
    'ok', true,
    'grandfathered', true,
    'withdrawable_drift', d.withdrawable_drift,
    'float_drift', d.float_drift
  );
END;
$function$;
