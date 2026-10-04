-- Patch v_user_wallet_strict so CFO admin debits via 'system_balance_correction'
-- actually reduce the user's withdrawable balance. Previously the view dropped
-- every (classification='admin_correction', category='system_balance_correction')
-- row, which meant CFO reconciliation debits could never neutralize phantom
-- withdrawable (root cause of the PC020 / Onesmus 513,300 incident).
--
-- Rule going forward:
--   * Admin system_balance_correction DEBITS are kept and route to 'withdrawable'
--     via wallet_route_for_category (already returns ('withdrawable', -1) for this
--     category + 'debit'). They can only REDUCE withdrawable.
--   * Admin system_balance_correction CREDITS remain excluded so admin corrections
--     can never inflate a user's withdrawable.
--
-- get_user_available_balance already delegates to v_user_wallet_strict, so the
-- approve-withdrawal gate inherits the fix automatically.

CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM wallet_fresh_start_anchors
),
ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount, gl.wallet_bucket
  FROM general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification = 'production'
         -- keep admin_correction system_balance_correction DEBITS so CFO
         -- reductions actually shrink withdrawable; credits stay excluded
         OR (gl.classification = 'admin_correction'
             AND gl.category = 'system_balance_correction'
             AND gl.direction IN ('debit','cash_out')))
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
),
routed_explicit AS (
  SELECT user_id, amount, wallet_bucket AS bucket,
    CASE WHEN direction IN ('cash_in','credit') THEN 1
         WHEN direction IN ('cash_out','debit') THEN -1
         ELSE 0 END AS sign
  FROM ledger
  WHERE wallet_bucket IN ('withdrawable','float','advance_credit','advance_repayment')
),
routed_category AS (
  SELECT l.user_id, l.amount, r.bucket, r.sign
  FROM ledger l
  CROSS JOIN LATERAL wallet_route_for_category(l.user_id, l.category, l.direction) r(bucket, sign)
  WHERE l.wallet_bucket IS NULL
),
routed AS (
  SELECT * FROM routed_explicit
  UNION ALL
  SELECT * FROM routed_category
),
buckets AS (
  SELECT user_id,
    sum(CASE WHEN bucket='withdrawable' THEN sign::numeric*amount ELSE 0 END) AS withdrawable_raw,
    sum(CASE WHEN bucket='float' THEN sign::numeric*amount ELSE 0 END) AS float_raw,
    sum(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign::numeric*amount ELSE 0 END) AS advance_raw
  FROM routed
  GROUP BY user_id
),
holds AS (
  SELECT user_id, COALESCE(sum(amount),0) AS pending_holds
  FROM withdrawal_requests
  WHERE status IN ('pending','requested','manager_approved','processing')
  GROUP BY user_id
),
universe AS (
  SELECT user_id FROM wallets_physical
  UNION SELECT user_id FROM buckets
  UNION SELECT user_id FROM holds
)
SELECT u.user_id,
  GREATEST(0::numeric, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0)) AS withdrawable,
  GREATEST(0::numeric, COALESCE(b.float_raw,0)) AS float_balance,
  GREATEST(0::numeric, COALESCE(b.advance_raw,0)) AS advance_balance,
  COALESCE(h.pending_holds,0) AS pending_holds,
  GREATEST(0::numeric, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0))
    + GREATEST(0::numeric, COALESCE(b.float_raw,0)) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds h ON h.user_id = u.user_id;