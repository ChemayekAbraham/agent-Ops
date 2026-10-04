-- Treat 'test_funds_cleanup' as float bucket in v_user_wallet_strict so test seedings
-- can never appear as withdrawable to end users. SSENKAALI PIUS investigation revealed
-- a production-classified 5,000,000 UGX test seed inflating withdrawable.
CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM wallet_fresh_start_anchors
),
ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount
  FROM general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification = 'production')
    AND NOT (COALESCE(gl.classification,'') = 'admin_correction'
             AND COALESCE(gl.category,'') = 'system_balance_correction')
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
),
buckets AS (
  SELECT
    user_id,
    SUM(CASE
      WHEN COALESCE(category,'') NOT IN (
        'agent_float_deposit','agent_float_used_for_rent','agent_float_settlement',
        'agent_float_assignment','rent_float_funding','partner_funding',
        'test_funds_cleanup'
      ) AND COALESCE(category,'') NOT LIKE 'advance_%' THEN
        CASE WHEN direction='cash_in' THEN amount
             WHEN direction='cash_out' THEN -amount ELSE 0 END
      ELSE 0
    END) AS withdrawable_raw,
    SUM(CASE
      WHEN COALESCE(category,'') IN (
        'agent_float_deposit','agent_float_used_for_rent','agent_float_settlement',
        'agent_float_assignment','rent_float_funding','partner_funding',
        'test_funds_cleanup'
      ) THEN
        CASE WHEN direction='cash_in' THEN amount
             WHEN direction='cash_out' THEN -amount ELSE 0 END
      ELSE 0
    END) AS float_raw,
    SUM(CASE
      WHEN COALESCE(category,'') LIKE 'advance_%' THEN
        CASE WHEN direction='cash_in' THEN amount
             WHEN direction='cash_out' THEN -amount ELSE 0 END
      ELSE 0
    END) AS advance_raw
  FROM ledger
  GROUP BY user_id
),
holds AS (
  SELECT user_id, COALESCE(SUM(amount),0) AS pending_holds
  FROM withdrawal_requests
  WHERE status IN ('pending','requested','manager_approved','processing')
  GROUP BY user_id
),
universe AS (
  SELECT user_id FROM wallets_physical
  UNION SELECT user_id FROM buckets
  UNION SELECT user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(0, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0)) AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw,0)) AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw,0)) AS advance_balance,
  COALESCE(h.pending_holds,0) AS pending_holds,
  GREATEST(0, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0))
    + GREATEST(0, COALESCE(b.float_raw,0)) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds h ON h.user_id = u.user_id;