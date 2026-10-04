-- STEP 1 (read-only compatibility wrapper). No wallet writes. Reconciliation remains disabled.
CREATE OR REPLACE VIEW public.v_pivot_drift
WITH (security_invoker = true) AS
SELECT
  w.user_id,
  COALESCE(pw.balance_sum, 0)::numeric AS pivot_withdrawable,
  COALESCE(pf.balance_sum, 0)::numeric AS pivot_float,
  COALESCE(pa.balance_sum, 0)::numeric AS pivot_advance,
  COALESCE(w.withdrawable_balance, 0)::numeric AS cache_withdrawable,
  COALESCE(w.float_balance, 0)::numeric AS cache_float,
  COALESCE(w.advance_balance, 0)::numeric AS cache_advance,
  (COALESCE(pw.balance_sum, 0) - COALESCE(w.withdrawable_balance, 0))::numeric AS withdrawable_delta,
  (COALESCE(pf.balance_sum, 0) - COALESCE(w.float_balance, 0))::numeric AS float_delta,
  (COALESCE(pa.balance_sum, 0) - COALESCE(w.advance_balance, 0))::numeric AS advance_delta,
  (pw.user_id IS NOT NULL OR pf.user_id IS NOT NULL OR pa.user_id IS NOT NULL) AS has_pivot_row
FROM public.wallets w
LEFT JOIN public.ledger_balance_pivot pw
  ON pw.user_id = w.user_id AND pw.bucket = 'withdrawable'
LEFT JOIN public.ledger_balance_pivot pf
  ON pf.user_id = w.user_id AND pf.bucket = 'float'
LEFT JOIN public.ledger_balance_pivot pa
  ON pa.user_id = w.user_id AND pa.bucket = 'advance';

REVOKE ALL ON public.v_pivot_drift FROM anon, authenticated;
GRANT SELECT ON public.v_pivot_drift TO service_role;