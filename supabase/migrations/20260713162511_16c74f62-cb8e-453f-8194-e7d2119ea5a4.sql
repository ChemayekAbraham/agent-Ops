
CREATE OR REPLACE FUNCTION public.refresh_wallet_totals_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300000'
AS $fn$
DECLARE
  v_total_wallets bigint;
  v_active_wallets bigint;
  v_total_balance numeric;
  v_total_float numeric;
  v_total_withdrawable numeric;
  v_strict_total numeric;
  v_drifted_wallets bigint;
  v_total_drift numeric;
BEGIN
  -- Headline totals + wallet count in a single scan of the strict ledger view.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE(total_visible, 0) > 0),
    COALESCE(SUM(COALESCE(total_visible, 0)), 0),
    COALESCE(SUM(COALESCE(float_balance, 0)), 0),
    COALESCE(SUM(COALESCE(withdrawable, 0)), 0)
  INTO v_total_wallets, v_active_wallets, v_total_balance, v_total_float, v_total_withdrawable
  FROM public.v_user_wallet_strict
  WHERE user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid;

  -- Strict ledger + drift totals (mirrors the previous get_wallet_totals_strict body)
  WITH targets AS (
    SELECT
      w.user_id,
      COALESCE(w.balance, 0)::numeric AS cached_balance,
      (COALESCE(t.target_withdrawable, 0) + COALESCE(t.target_float, 0))::numeric AS ledger_cache_target,
      COALESCE(s.total_visible, 0)::numeric AS strict_total_visible
    FROM public.wallets w
    LEFT JOIN LATERAL (
      WITH anchor AS (
        SELECT anchor_at FROM public.wallet_fresh_start_anchors WHERE user_id = w.user_id
      ), ledger AS (
        SELECT gl.category, gl.direction, gl.amount
        FROM public.general_ledger gl
        LEFT JOIN anchor a ON true
        WHERE gl.user_id = w.user_id
          AND gl.ledger_scope = 'wallet'
          AND (gl.classification IS NULL OR gl.classification = 'production')
          AND COALESCE(gl.category, '') <> 'system_balance_correction'
          AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      )
      SELECT
        GREATEST(0, COALESCE(SUM(CASE
          WHEN COALESCE(category, '') NOT IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
           AND COALESCE(category, '') NOT LIKE 'advance_%'
          THEN CASE WHEN direction = 'cash_in' THEN amount WHEN direction = 'cash_out' THEN -amount ELSE 0 END
          ELSE 0 END), 0))::numeric AS target_withdrawable,
        GREATEST(0, COALESCE(SUM(CASE
          WHEN COALESCE(category, '') IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
          THEN CASE WHEN direction = 'cash_in' THEN amount WHEN direction = 'cash_out' THEN -amount ELSE 0 END
          ELSE 0 END), 0))::numeric AS target_float
      FROM ledger
    ) t ON true
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
    WHERE w.user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  )
  SELECT
    COALESCE(SUM(strict_total_visible), 0),
    COUNT(*) FILTER (WHERE ABS(cached_balance - ledger_cache_target) > 100),
    COALESCE(SUM(GREATEST(cached_balance - ledger_cache_target, 0)), 0)
  INTO v_strict_total, v_drifted_wallets, v_total_drift
  FROM targets;

  INSERT INTO public.wallet_totals_cache AS c (
    id, total_wallets, active_wallets, total_balance, total_float, total_withdrawable,
    strict_total, drifted_wallets, total_drift, computed_at
  ) VALUES (
    1, v_total_wallets, v_active_wallets, v_total_balance, v_total_float, v_total_withdrawable,
    v_strict_total, v_drifted_wallets, v_total_drift, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    total_wallets      = EXCLUDED.total_wallets,
    active_wallets     = EXCLUDED.active_wallets,
    total_balance      = EXCLUDED.total_balance,
    total_float        = EXCLUDED.total_float,
    total_withdrawable = EXCLUDED.total_withdrawable,
    strict_total       = EXCLUDED.strict_total,
    drifted_wallets    = EXCLUDED.drifted_wallets,
    total_drift        = EXCLUDED.total_drift,
    computed_at        = EXCLUDED.computed_at;
END;
$fn$;

REVOKE ALL ON FUNCTION public.refresh_wallet_totals_cache() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_wallet_totals_cache() TO service_role;
