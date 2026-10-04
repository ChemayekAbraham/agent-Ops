-- Proxy reserve attribution fix.
-- Previously the `holds` CTE grouped pending withdrawal_requests by user_id,
-- so a proxy withdrawal (user_id = partner) reserved money against the
-- partner's wallet. Proxy withdrawals are funded by the proxy AGENT's wallet,
-- so the reserve must follow the money: attribute proxy holds to agent_id.
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
  -- Proxy withdrawals are funded by the proxy AGENT's wallet, so their
  -- pending reserve must reduce the agent's spendable balance, not the
  -- partner's. Attribute the hold to agent_id when this is a proxy row
  -- (proxy_partner_id IS NOT NULL and an agent is on the row); otherwise
  -- keep it on the requester (user_id) as before.
  SELECT
    CASE
      WHEN proxy_partner_id IS NOT NULL AND agent_id IS NOT NULL THEN agent_id
      ELSE user_id
    END AS user_id,
    COALESCE(sum(amount),0) AS pending_holds
  FROM withdrawal_requests
  WHERE status IN ('pending','requested','manager_approved','processing')
  GROUP BY 1
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