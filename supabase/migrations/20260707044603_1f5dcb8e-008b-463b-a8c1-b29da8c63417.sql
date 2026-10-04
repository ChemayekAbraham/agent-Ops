-- ============================================================
-- Finding 1: recreate missing wallet_pivot_drift_view
-- (validate_wallet_against_pivot / reconcile_wallet_from_pivot
--  depend on it; the view was never present in the live DB)
-- ============================================================
CREATE OR REPLACE VIEW public.wallet_pivot_drift_view AS
WITH p AS (
  SELECT
    user_id,
    SUM(CASE WHEN bucket='withdrawable' THEN balance_sum ELSE 0 END) AS pivot_withdrawable,
    SUM(CASE WHEN bucket='float'        THEN balance_sum ELSE 0 END) AS pivot_float,
    SUM(CASE WHEN bucket='advance'      THEN balance_sum ELSE 0 END) AS pivot_advance
  FROM public.ledger_balance_pivot GROUP BY user_id
)
SELECT
  w.user_id,
  w.withdrawable_balance AS cache_withdrawable,
  COALESCE(p.pivot_withdrawable,0) AS pivot_withdrawable,
  (w.withdrawable_balance - COALESCE(p.pivot_withdrawable,0)) AS withdrawable_drift,
  w.float_balance AS cache_float,
  COALESCE(p.pivot_float,0) AS pivot_float,
  (w.float_balance - COALESCE(p.pivot_float,0)) AS float_drift,
  w.advance_balance AS cache_advance,
  COALESCE(p.pivot_advance,0) AS pivot_advance,
  (w.advance_balance - COALESCE(p.pivot_advance,0)) AS advance_drift
FROM public.wallets w
LEFT JOIN p ON p.user_id = w.user_id;

-- ============================================================
-- Finding 3: missing GRANTs on agent_advance_requests.
-- RLS policies already exist (INSERT/SELECT for authenticated,
-- UPDATE/SELECT for ops staff) but no table-level GRANT was
-- present, so PostgREST returned "permission denied".
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.agent_advance_requests TO authenticated;
GRANT ALL ON public.agent_advance_requests TO service_role;

-- ============================================================
-- Finding 6: general_ledger.sub_category missing in prod though
-- declared in generated types + referenced by finance tools.
-- ============================================================
ALTER TABLE public.general_ledger ADD COLUMN IF NOT EXISTS sub_category text;