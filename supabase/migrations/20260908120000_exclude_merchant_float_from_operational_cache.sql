-- Operational Float cache double-counted active merchant desk agents.
--
-- WHY. refresh_wallet_totals_cache() summed float_balance across every wallet
-- in v_user_wallet_strict with no exclusion, so an active merchant desk
-- agent's float (e.g. Sky Bubbles, Mudumba samuel) was counted in
-- wallet_totals_cache.total_float (surfaced as the "Operational Float" tile
-- via get_wallet_bucket_totals, and as payables.wallet_float in
-- get_cfo_weekly_report) AND separately in get_wallet_bucket_totals'
-- merchant_float_total -- the same money showing up in both buckets.
--
-- Reported 2026-09-08: CFO screenshot of "Merchant Float — Holders" showed
-- these same agents, confirming the double count.
--
-- Same exclusion rule already used by WalletBucketHoldersPanel's 'float'
-- branch and get_merchant_float_positions: an ACTIVE desk's float belongs
-- only in Merchant Float; a RETIRED desk's float reverts to plain
-- operational float and stays counted here.
--
-- total_balance and total_withdrawable are untouched -- they represent total
-- money owed across all buckets, which correctly still includes merchant
-- desk agents. Only the float_total sub-bucket split changes.

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
  v_landlord_float_total numeric;
BEGIN
  SELECT COALESCE(SUM(balance), 0) INTO v_landlord_float_total
  FROM public.agent_landlord_float;

  -- Headline totals + wallet count in a single scan of the strict ledger view.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE(total_visible, 0) > 0),
    COALESCE(SUM(COALESCE(total_visible, 0)), 0) + v_landlord_float_total,
    COALESCE(SUM(COALESCE(float_balance, 0)) FILTER (WHERE ca.agent_id IS NULL), 0) + v_landlord_float_total,
    COALESCE(SUM(COALESCE(withdrawable, 0)), 0)
  INTO v_total_wallets, v_active_wallets, v_total_balance, v_total_float, v_total_withdrawable
  FROM public.v_user_wallet_strict v
  LEFT JOIN public.cashout_agents ca ON ca.agent_id = v.user_id AND ca.is_active = true
  WHERE v.user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid;

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
    COALESCE(SUM(strict_total_visible), 0) + v_landlord_float_total,
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

-- Recompute immediately so the cache (and every dashboard reading it) reflects
-- the corrected split right away rather than waiting for the next scheduled run.
SELECT public.refresh_wallet_totals_cache();
