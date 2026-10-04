
DROP VIEW IF EXISTS public.v_pivot_drift;

CREATE VIEW public.v_pivot_drift AS
WITH p AS (
  SELECT
    user_id,
    GREATEST(0, COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN balance_sum END), 0)) AS pivot_withdrawable,
    GREATEST(0, COALESCE(SUM(CASE WHEN bucket = 'float' THEN balance_sum END), 0)) AS pivot_float,
    GREATEST(0, COALESCE(SUM(CASE WHEN bucket = 'advance' THEN balance_sum END), 0)) AS pivot_advance
  FROM public.ledger_balance_pivot
  GROUP BY user_id
)
SELECT
  COALESCE(p.user_id, s.user_id) AS user_id,
  p.pivot_withdrawable,
  GREATEST(0, COALESCE(s.withdrawable,0) + COALESCE(s.pending_holds,0)) AS strict_withdrawable_pre_holds,
  p.pivot_withdrawable - GREATEST(0, COALESCE(s.withdrawable,0) + COALESCE(s.pending_holds,0)) AS withdrawable_delta,
  p.pivot_float,
  COALESCE(s.float_balance,0) AS strict_float,
  p.pivot_float - COALESCE(s.float_balance,0) AS float_delta,
  p.pivot_advance,
  COALESCE(s.advance_balance,0) AS strict_advance,
  p.pivot_advance - COALESCE(s.advance_balance,0) AS advance_delta
FROM p
FULL OUTER JOIN public.v_user_wallet_strict s ON s.user_id = p.user_id
WHERE
     ABS(COALESCE(p.pivot_withdrawable,0) - GREATEST(0, COALESCE(s.withdrawable,0) + COALESCE(s.pending_holds,0))) > 0.005
  OR ABS(COALESCE(p.pivot_float,0) - COALESCE(s.float_balance,0)) > 0.005
  OR ABS(COALESCE(p.pivot_advance,0) - COALESCE(s.advance_balance,0)) > 0.005;

GRANT SELECT ON public.v_pivot_drift TO authenticated;
