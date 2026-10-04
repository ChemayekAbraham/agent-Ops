-- Fix a live, active bug: tg_ledger_pivot_apply (fires on every wallet-scope
-- general_ledger insert) and wallet_pivot_drift_view both read
-- 'withdrawable_raw'/'float_raw'/'advance_raw' out of get_user_wallet_view()'s
-- jsonb result. Those keys were added to get_user_wallet_view specifically for
-- this pivot system on 2026-07-07 (20260707081808_...sql) -- but
-- get_user_wallet_view was rewritten on 2026-08-11
-- (20260811050458_wallet_projection_dirty_flag_deferral.sql) to read from
-- wallet_balances_projection instead of computing live, and the new version
-- does not return those keys at all. Every ->>'*_raw' lookup since then
-- resolves to NULL -> COALESCE'd to 0, so tg_ledger_pivot_apply has been
-- writing balance_sum = 0 into ledger_balance_pivot for every bucket, for
-- every user, on every ledger write, since 2026-08-11.
--
-- This pivot feeds v_pivot_drift (20260731234456_...sql), which the
-- 'reconcile-wallets-from-pivot' cron job (every 10 minutes,
-- reconcile_wallets_batch -> reconcile_wallet_from_pivot,
-- 20260506115147_.../20260603164504_...sql) reads directly. Its logic:
-- if |drift| < 1000 UGX it AUTO-REPAIRS by writing the (broken, always-0)
-- pivot value straight into wallets.withdrawable_balance/float_balance/
-- advance_balance. So this has not just been logging false drift -- for
-- every user with a real balance under ~1000 UGX, it has been actively
-- zeroing their cached wallet balance every 10 minutes since 2026-08-11.
-- Larger balances only got logged to phantom_wallet_drift (status 'open'),
-- not directly corrupted.
--
-- Root cause of why this broke TWICE on the same contract: both the trigger
-- and the drift view depended on get_user_wallet_view's return shape, which
-- is a general-purpose, evolving function. This migration decouples them by
-- introducing a small, dedicated, single-purpose function that only the pivot
-- system uses, so a future get_user_wallet_view change cannot silently break
-- pivot reconciliation again.

-- 1. Dedicated raw (pre-hold) bucket-sum function, extracted from the
--    2026-07-07 get_user_wallet_view routing logic, owned solely by the pivot
--    system from now on.
CREATE OR REPLACE FUNCTION public.get_user_wallet_raw_buckets(p_user_id uuid)
RETURNS TABLE (withdrawable_raw numeric, float_raw numeric, advance_raw numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor_at timestamptz;
  v_is_agent  boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    withdrawable_raw := 0; float_raw := 0; advance_raw := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT anchor_at INTO v_anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id
  ORDER BY anchor_at DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id AND role = 'agent' AND COALESCE(enabled, true) = true
  ) INTO v_is_agent;

  RETURN QUERY
  WITH routed AS (
    SELECT
      CASE WHEN gl.direction IN ('cash_in','credit') THEN 1 ELSE -1 END AS sign,
      gl.amount,
      CASE
        WHEN gl.wallet_bucket IN ('withdrawable','float','advance_credit','advance_repayment')
          THEN gl.wallet_bucket
        WHEN gl.wallet_bucket IS NULL THEN
          CASE
            WHEN v_is_agent AND gl.direction IN ('cash_in','credit')
                 AND gl.category IN (
                   'cfo_direct_credit','pool_capital_received','partner_funding',
                   'supporter_capital','supporter_rent_fund','manager_credit'
                 ) THEN 'float'
            WHEN v_is_agent AND gl.direction IN ('cash_out','debit')
                 AND gl.category IN (
                   'agent_proxy_investment','coo_proxy_investment',
                   'pending_portfolio_topup','proxy_partner_withdrawal',
                   'rent_payment_for_tenant','rent_obligation','cfo_direct_credit'
                 ) THEN 'float'
            WHEN gl.category IN (
                   'agent_float_deposit','agent_float_assignment','agent_float_topup',
                   'agent_float_funding','agent_float_used_for_rent','agent_float_used',
                   'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
                 ) THEN 'float'
            WHEN gl.category IN ('agent_advance_credit','salary_advance')
                 AND gl.direction IN ('cash_in','credit') THEN 'advance_credit'
            WHEN gl.category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery')
                 AND gl.direction IN ('cash_out','debit') THEN 'advance_repayment'
            ELSE 'withdrawable'
          END
        ELSE NULL
      END AS bucket
    FROM public.general_ledger gl
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND gl.direction IN ('cash_in','credit','cash_out','debit')
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction IN ('debit','cash_out')
        )
      )
      AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign * amount ELSE 0 END), 0)
  FROM routed;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_user_wallet_raw_buckets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_wallet_raw_buckets(uuid) TO service_role;

-- 2. Point the trigger at the dedicated function instead of get_user_wallet_view.
CREATE OR REPLACE FUNCTION public.tg_ledger_pivot_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  b record;
BEGIN
  IF NEW.user_id IS NULL OR COALESCE(NEW.ledger_scope,'wallet') <> 'wallet' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO b FROM public.get_user_wallet_raw_buckets(NEW.user_id);

  INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
    VALUES (NEW.user_id, 'withdrawable', COALESCE(b.withdrawable_raw, 0), now())
    ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
  INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
    VALUES (NEW.user_id, 'float', COALESCE(b.float_raw, 0), now())
    ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
  INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
    VALUES (NEW.user_id, 'advance', COALESCE(b.advance_raw, 0), now())
    ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();

  RETURN NEW;
END;
$function$;

-- 3. Same fix for wallet_pivot_drift_view (not cron-consumed today, but reads
--    the identical broken keys -- fixed for correctness/future use).
CREATE OR REPLACE VIEW public.wallet_pivot_drift_view AS
WITH p AS (
  SELECT ledger_balance_pivot.user_id,
    sum(CASE WHEN ledger_balance_pivot.bucket = 'withdrawable' THEN ledger_balance_pivot.balance_sum ELSE 0::numeric END) AS pivot_withdrawable,
    sum(CASE WHEN ledger_balance_pivot.bucket = 'float' THEN ledger_balance_pivot.balance_sum ELSE 0::numeric END) AS pivot_float,
    sum(CASE WHEN ledger_balance_pivot.bucket = 'advance' THEN ledger_balance_pivot.balance_sum ELSE 0::numeric END) AS pivot_advance
  FROM ledger_balance_pivot
  GROUP BY ledger_balance_pivot.user_id
)
SELECT wp.user_id,
  COALESCE(b.withdrawable_raw, 0::numeric) AS cache_withdrawable,
  COALESCE(p.pivot_withdrawable, 0::numeric) AS pivot_withdrawable,
  COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(p.pivot_withdrawable, 0::numeric) AS withdrawable_drift,
  COALESCE(b.float_raw, 0::numeric) AS cache_float,
  COALESCE(p.pivot_float, 0::numeric) AS pivot_float,
  COALESCE(b.float_raw, 0::numeric) - COALESCE(p.pivot_float, 0::numeric) AS float_drift,
  COALESCE(b.advance_raw, 0::numeric) AS cache_advance,
  COALESCE(p.pivot_advance, 0::numeric) AS pivot_advance,
  COALESCE(b.advance_raw, 0::numeric) - COALESCE(p.pivot_advance, 0::numeric) AS advance_drift
FROM wallets_physical wp
LEFT JOIN LATERAL public.get_user_wallet_raw_buckets(wp.user_id) b ON true
LEFT JOIN p ON p.user_id = wp.user_id;

-- 4. Immediate repair: recompute every pivot row right now from the correct
--    raw buckets, instead of waiting for each user's next ledger write.
INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
SELECT wp.user_id, buck.bucket,
  CASE buck.bucket
    WHEN 'withdrawable' THEN COALESCE(b.withdrawable_raw, 0)
    WHEN 'float'        THEN COALESCE(b.float_raw, 0)
    WHEN 'advance'      THEN COALESCE(b.advance_raw, 0)
  END,
  now()
FROM public.wallets_physical wp
CROSS JOIN (VALUES ('withdrawable'),('float'),('advance')) AS buck(bucket)
LEFT JOIN LATERAL public.get_user_wallet_raw_buckets(wp.user_id) b ON true
ON CONFLICT (user_id, bucket) DO UPDATE
  SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
