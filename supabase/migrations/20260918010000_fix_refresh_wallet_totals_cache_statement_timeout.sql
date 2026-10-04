-- refresh-wallet-totals-cache (cron) has been failing intermittently with
-- "canceling statement due to statement timeout" (5 min, set on the function
-- itself) -- confirmed live in cron.job_run_details, e.g. the 2026-09-17
-- 12:06 UTC run, error raised inside wallet_route_for_category's LATERAL
-- subquery. The drift/reconciliation block ran a per-wallet correlated
-- LATERAL subquery (one general_ledger scan + aggregate per row) across all
-- 96,711 wallets. Rewritten as a single GROUP BY over the wallet-scope
-- ledger (282k rows) joined once to wallets, which is behaviourally
-- identical (wallet_fresh_start_anchors has exactly one row per user_id --
-- confirmed live, 6,052 total = 6,052 distinct -- so folding the anchor into
-- the join before aggregating doesn't change which ledger rows count) but
-- replaces ~96,711 subquery executions with one aggregate scan.
CREATE OR REPLACE FUNCTION public.refresh_wallet_totals_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300000'
AS $function$
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

  -- Strict ledger + drift totals (mirrors the previous get_wallet_totals_strict body),
  -- rewritten from a per-wallet LATERAL subquery to a single set-based aggregate.
  WITH ledger_totals AS (
    SELECT
      gl.user_id,
      GREATEST(0, COALESCE(SUM(CASE
        WHEN COALESCE(gl.category, '') NOT IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
         AND COALESCE(gl.category, '') NOT LIKE 'advance_%'
        THEN CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount ELSE 0 END
        ELSE 0 END), 0))::numeric AS target_withdrawable,
      GREATEST(0, COALESCE(SUM(CASE
        WHEN COALESCE(gl.category, '') IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
        THEN CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount ELSE 0 END
        ELSE 0 END), 0))::numeric AS target_float
    FROM public.general_ledger gl
    LEFT JOIN public.wallet_fresh_start_anchors a ON a.user_id = gl.user_id
    WHERE gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production')
      AND COALESCE(gl.category, '') <> 'system_balance_correction'
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
    GROUP BY gl.user_id
  ),
  targets AS (
    SELECT
      w.user_id,
      COALESCE(w.balance, 0)::numeric AS cached_balance,
      (COALESCE(lt.target_withdrawable, 0) + COALESCE(lt.target_float, 0))::numeric AS ledger_cache_target,
      COALESCE(s.total_visible, 0)::numeric AS strict_total_visible
    FROM public.wallets w
    LEFT JOIN ledger_totals lt ON lt.user_id = w.user_id
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
$function$;
