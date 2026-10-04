-- Phone Money vs Platform Money reconciliation + deposit auto-credit success rate.
--
-- "Phone Money" = the real balance sitting on the company's MTN/Airtel merchant
-- SIM lines. That number already exists in this database: the Gmail poller
-- (supabase/functions/gmail-poll-transactions/index.ts) parses the running
-- balance out of every MTN/Airtel confirmation SMS ("New balance: X" / "Bal: X")
-- and stores it on gmail_transactions.balance, tagged by channel. Since IFTTT
-- forwards every SMS from the one physical merchant phone, the most recent
-- balance row per channel IS the current real phone balance.
--
-- "Platform Money" reads wallet_totals_cache.total_balance -- the same
-- ledger-derived figure the existing "Total Money in All Wallets" card shows
-- (see 20260713161737_...sql) -- so the two cards never disagree.

-- 1. Indexes to serve the two new lookups.
CREATE INDEX IF NOT EXISTS idx_gmail_tx_channel_balance_latest
  ON public.gmail_transactions (channel, internal_date DESC)
  WHERE balance IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gmail_tx_autocredit_success_window
  ON public.gmail_transactions (direction, channel, parsed, internal_date DESC);

-- 2. Phone vs platform reconciliation. Live-computed (no cache table/cron --
-- both lookups are indexed and cheap): latest MTN balance, latest Airtel
-- balance, their sum vs 50% of platform money. Tolerance is a floor of
-- 500,000 UGX OR 15% of the expected phone total, whichever is larger, so
-- small platform sizes don't false-alarm and rounding noise doesn't flag on
-- every page load. Only flags when phone money is BELOW target minus
-- tolerance -- a surplus never triggers a warning.
CREATE OR REPLACE FUNCTION public.get_phone_platform_reconciliation()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH latest_mtn AS (
    SELECT balance, internal_date FROM public.gmail_transactions
    WHERE channel = 'mtn_momo' AND balance IS NOT NULL
    ORDER BY internal_date DESC LIMIT 1
  ), latest_airtel AS (
    SELECT balance, internal_date FROM public.gmail_transactions
    WHERE channel = 'airtel_money' AND balance IS NOT NULL
    ORDER BY internal_date DESC LIMIT 1
  ), platform AS (
    SELECT COALESCE(total_balance, 0) AS total_balance, computed_at
    FROM public.wallet_totals_cache WHERE id = 1
  ), calc AS (
    SELECT
      COALESCE(m.balance, 0) AS mtn_balance, m.internal_date AS mtn_last_sms_at,
      COALESCE(a.balance, 0) AS airtel_balance, a.internal_date AS airtel_last_sms_at,
      COALESCE(m.balance, 0) + COALESCE(a.balance, 0) AS phone_total,
      p.total_balance AS platform_total, p.computed_at AS platform_computed_at,
      p.total_balance * 0.5 AS expected_phone_total
    FROM platform p
    LEFT JOIN latest_mtn m ON true
    LEFT JOIN latest_airtel a ON true
  )
  SELECT json_build_object(
    'mtn_balance', mtn_balance, 'mtn_last_sms_at', mtn_last_sms_at,
    'airtel_balance', airtel_balance, 'airtel_last_sms_at', airtel_last_sms_at,
    'phone_total', phone_total,
    'platform_total', platform_total, 'platform_computed_at', platform_computed_at,
    'target_ratio', 0.5, 'expected_phone_total', expected_phone_total,
    'gap_amount', phone_total - expected_phone_total,
    'gap_pct', CASE WHEN expected_phone_total = 0 THEN 0
                ELSE ROUND(((phone_total - expected_phone_total) / expected_phone_total) * 100, 2) END,
    'tolerance_amount', GREATEST(500000, expected_phone_total * 0.15),
    'is_on_target', (phone_total - expected_phone_total) >= -GREATEST(500000, expected_phone_total * 0.15),
    'computed_at', now()
  ) FROM calc;
$fn$;

REVOKE ALL ON FUNCTION public.get_phone_platform_reconciliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_phone_platform_reconciliation() TO authenticated;

-- 3. Deposit auto-credit success rate: among parsed inbound MTN/Airtel SMS,
-- what fraction ended up auto-credited to a wallet (linked_deposit_request_id
-- or auto_matched_at set) vs left for manual review. NULL (not 0) when there
-- were zero attempts in the window, so the UI can show a neutral "no
-- activity" state instead of a false "0% failure".
CREATE OR REPLACE FUNCTION public.get_deposit_autocredit_success_rate(p_window_hours integer DEFAULT 24)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH scoped AS (
    SELECT linked_deposit_request_id, auto_matched_at
    FROM public.gmail_transactions
    WHERE direction = 'in' AND channel IN ('mtn_momo', 'airtel_money') AND parsed = true
      AND internal_date >= now() - (GREATEST(p_window_hours, 1) || ' hours')::interval
  ), agg AS (
    SELECT COUNT(*) AS attempted,
      COUNT(*) FILTER (WHERE linked_deposit_request_id IS NOT NULL OR auto_matched_at IS NOT NULL) AS successful
    FROM scoped
  )
  SELECT json_build_object(
    'attempted', attempted, 'successful', successful,
    'success_rate_pct', CASE WHEN attempted = 0 THEN NULL ELSE ROUND((successful::numeric / attempted) * 100, 1) END,
    'window_hours', GREATEST(p_window_hours, 1), 'computed_at', now()
  ) FROM agg;
$fn$;

REVOKE ALL ON FUNCTION public.get_deposit_autocredit_success_rate(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_deposit_autocredit_success_rate(integer) TO authenticated;
