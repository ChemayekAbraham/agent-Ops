-- 2026-09-11 Daily CTO Report: SELECT public.reconcile_wallets_batch($1, $2)
-- flagged critical — 8,220 calls/day at 39,373ms mean, the second slowest
-- statement platform-wide.
--
-- reconcile_wallets_batch(p_threshold, p_limit) (20260603164504) selects up
-- to p_limit=5000 drifted user_ids from v_pivot_drift in one query, then
-- loops calling reconcile_wallet_from_pivot(user_id) per row — which itself
-- re-runs `SELECT * FROM v_pivot_drift WHERE user_id = p_user_id`,
-- re-evaluating the whole drift view once per user instead of reusing the
-- row the outer query already fetched. That's an N+1 against a
-- ledger-aggregating view, up to 5,000 times, every 10 minutes.
--
-- The correct fix is to stop re-querying v_pivot_drift per row (pass the
-- already-fetched drift columns straight into the repair step), but
-- reconcile_wallet_from_pivot is also called individually and outside this
-- batch, from supabase/functions/approve-withdrawal and agent-withdrawal
-- (per mem/constraints/pivot-usage-policy.md's debit-path self-heal step),
-- so reshaping its signature needs its own change plus verification against
-- those two callers — not bundled into a report-driven cleanup pass.
--
-- As an immediate, zero-behavior-risk mitigation — this is a self-feeding
-- background reconciliation loop (pivot-usage-policy.md: "auto-repairs
-- wallet when |drift| < threshold; logs to phantom_wallet_drift when over"),
-- not a one-shot job, so a smaller batch only spreads the same repair work
-- across more 10-minute ticks, it never skips a drifted wallet — cut the
-- per-run limit passed by the cron schedule.

SELECT cron.unschedule('reconcile-wallets-from-pivot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-wallets-from-pivot');

SELECT cron.schedule(
  'reconcile-wallets-from-pivot',
  '*/10 * * * *',
  $cron$ SELECT public.reconcile_wallets_batch(1000, 1500); $cron$
);
