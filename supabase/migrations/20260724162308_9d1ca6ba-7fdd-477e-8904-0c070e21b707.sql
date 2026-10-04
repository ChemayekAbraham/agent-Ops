
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
  -- Only block when the cache OVERSTATES the ledger (positive drift = cache > pivot);
  -- a negative drift means the cache understates the ledger, and withdrawal gating
  -- against the smaller cached balance is inherently safe (no unbacked payout).
  IF coalesce(d.withdrawable_drift,0) >= p_threshold
     OR coalesce(d.float_drift,0) >= p_threshold THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'BALANCE_MISMATCH',
      'withdrawable_drift', d.withdrawable_drift,
      'float_drift', d.float_drift
    );
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'withdrawable_drift', d.withdrawable_drift,
    'float_drift', d.float_drift
  );
END;
$function$;
