WITH stuck AS (
  SELECT
    w.user_id,
    w.float_balance AS cached_float,
    (SELECT max(gl.created_at)
       FROM general_ledger gl
      WHERE gl.user_id = w.user_id
        AND gl.ledger_scope = 'wallet'
        AND gl.category = 'agent_float_deposit'
        AND gl.direction = 'cash_in'
        AND (gl.classification IS NULL OR gl.classification IN ('production','legacy_real'))
        AND gl.created_at >= now() - interval '7 days'
    ) AS recent_float_in_at,
    (SELECT coalesce(sum(CASE gl.direction WHEN 'cash_in' THEN gl.amount WHEN 'cash_out' THEN -gl.amount END), 0)
       FROM general_ledger gl
      WHERE gl.user_id = w.user_id
        AND gl.ledger_scope = 'wallet'
        AND gl.category IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
        AND (gl.classification IS NULL OR gl.classification IN ('production','legacy_real'))
    ) AS pre_anchor_float_net
  FROM wallets w
  JOIN v_user_wallet_strict v ON v.user_id = w.user_id
  WHERE w.float_balance > 0
    AND v.float_balance = 0
    AND NOT EXISTS (SELECT 1 FROM wallet_fresh_start_anchors a WHERE a.user_id = w.user_id)
), anchored AS (
  INSERT INTO wallet_fresh_start_anchors (user_id, anchor_at, pre_anchor_ledger_net, reason, notes)
  SELECT
    s.user_id,
    s.recent_float_in_at - interval '1 second',
    s.pre_anchor_float_net,
    'float_legacy_negative_drag',
    'Auto-anchored 2026-05-01: cached float positive, strict view zeroed by historical float-out without matching ledger float-in. Fresh deposits restored.'
  FROM stuck s
  WHERE s.recent_float_in_at IS NOT NULL
  RETURNING user_id, pre_anchor_ledger_net
)
INSERT INTO wallet_historical_drift_review
  (user_id, cached_withdrawable, pre_anchor_ledger_net, phantom_amount, status)
SELECT
  a.user_id,
  w.float_balance,
  a.pre_anchor_ledger_net,
  GREATEST(0, w.float_balance - GREATEST(0, a.pre_anchor_ledger_net)),
  'pending_review'
FROM anchored a
JOIN wallets w ON w.user_id = a.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM wallet_historical_drift_review r
  WHERE r.user_id = a.user_id AND r.status IN ('pending_review','pending_decision')
);