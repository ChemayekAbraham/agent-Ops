CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
),
ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount
  FROM public.general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification IN ('production','legacy_real'))
    AND gl.category <> 'system_balance_correction'
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
),
buckets AS (
  SELECT
    ledger.user_id,
    SUM(CASE
      WHEN COALESCE(ledger.category,'') NOT IN (
        'agent_float_deposit','agent_float_used_for_rent','agent_float_settlement',
        'agent_float_assignment','rent_float_funding','partner_funding'
      ) AND COALESCE(ledger.category,'') NOT LIKE 'advance_%' THEN
        CASE ledger.direction WHEN 'cash_in' THEN ledger.amount WHEN 'cash_out' THEN -ledger.amount ELSE 0 END
      ELSE 0 END) AS withdrawable_raw,
    SUM(CASE
      WHEN COALESCE(ledger.category,'') IN (
        'agent_float_deposit','agent_float_used_for_rent','agent_float_settlement',
        'agent_float_assignment','rent_float_funding','partner_funding'
      ) THEN
        CASE ledger.direction WHEN 'cash_in' THEN ledger.amount WHEN 'cash_out' THEN -ledger.amount ELSE 0 END
      ELSE 0 END) AS float_raw,
    SUM(CASE
      WHEN COALESCE(ledger.category,'') LIKE 'advance_%' THEN
        CASE ledger.direction WHEN 'cash_in' THEN ledger.amount WHEN 'cash_out' THEN -ledger.amount ELSE 0 END
      ELSE 0 END) AS advance_raw
  FROM ledger
  GROUP BY ledger.user_id
),
holds AS (
  SELECT user_id, COALESCE(SUM(amount),0) AS pending_holds
  FROM public.withdrawal_requests
  WHERE status IN ('pending','requested','manager_approved','processing')
  GROUP BY user_id
),
-- Universe of users to surface: anyone with a cached wallet OR any ledger activity OR a pending hold.
-- This guarantees users whose only wallet activity is system_balance_correction (e.g. payroll posted
-- as admin correction) still receive a row, with withdrawable clamped to the cached value.
universe AS (
  SELECT user_id FROM public.wallets
  UNION
  SELECT user_id FROM buckets
  UNION
  SELECT user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(
    0::numeric,
    LEAST(
      COALESCE(w.withdrawable_balance, 0),
      GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0))
        + GREATEST(0::numeric, COALESCE(w.withdrawable_balance, 0) - GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0)))
    ) - COALESCE(h.pending_holds, 0)
  ) AS withdrawable,
  GREATEST(0::numeric, COALESCE(b.float_raw, COALESCE(w.float_balance, 0))) AS float_balance,
  GREATEST(0::numeric, COALESCE(b.advance_raw, COALESCE(w.advance_balance, 0))) AS advance_balance,
  COALESCE(h.pending_holds, 0) AS pending_holds,
  GREATEST(
    0::numeric,
    LEAST(
      COALESCE(w.withdrawable_balance, 0),
      GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0))
        + GREATEST(0::numeric, COALESCE(w.withdrawable_balance, 0) - GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0)))
    ) - COALESCE(h.pending_holds, 0)
  ) + GREATEST(0::numeric, COALESCE(b.float_raw, COALESCE(w.float_balance, 0))) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds   h ON h.user_id = u.user_id
LEFT JOIN public.wallets w ON w.user_id = u.user_id;