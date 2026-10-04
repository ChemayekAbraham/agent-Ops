CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM wallet_fresh_start_anchors
), ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount
  FROM general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'::text
    AND (gl.classification IS NULL OR gl.classification = ANY (ARRAY['production'::text, 'legacy_real'::text]))
    AND gl.category <> 'system_balance_correction'::text
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
), buckets AS (
  SELECT
    ledger.user_id,
    SUM(
      CASE
        WHEN (COALESCE(ledger.category, '') <> ALL (ARRAY['agent_float_deposit'::text, 'agent_float_used_for_rent'::text, 'agent_float_settlement'::text, 'agent_float_assignment'::text, 'rent_float_funding'::text, 'partner_funding'::text]))
         AND COALESCE(ledger.category, '') NOT LIKE 'advance_%' THEN
          CASE ledger.direction
            WHEN 'cash_in'  THEN ledger.amount
            WHEN 'cash_out' THEN - ledger.amount
            ELSE 0::numeric
          END
        ELSE 0::numeric
      END
    ) AS withdrawable_raw,
    SUM(
      CASE
        WHEN COALESCE(ledger.category, '') = ANY (ARRAY['agent_float_deposit'::text, 'agent_float_used_for_rent'::text, 'agent_float_settlement'::text, 'agent_float_assignment'::text, 'rent_float_funding'::text, 'partner_funding'::text]) THEN
          CASE ledger.direction
            WHEN 'cash_in'  THEN ledger.amount
            WHEN 'cash_out' THEN - ledger.amount
            ELSE 0::numeric
          END
        ELSE 0::numeric
      END
    ) AS float_raw,
    SUM(
      CASE
        WHEN COALESCE(ledger.category, '') LIKE 'advance_%' THEN
          CASE ledger.direction
            WHEN 'cash_in'  THEN ledger.amount
            WHEN 'cash_out' THEN - ledger.amount
            ELSE 0::numeric
          END
        ELSE 0::numeric
      END
    ) AS advance_raw
  FROM ledger
  GROUP BY ledger.user_id
), holds AS (
  SELECT withdrawal_requests.user_id,
         COALESCE(SUM(withdrawal_requests.amount), 0::numeric) AS pending_holds
  FROM withdrawal_requests
  WHERE withdrawal_requests.status = ANY (ARRAY['pending'::text, 'requested'::text, 'manager_approved'::text, 'processing'::text])
  GROUP BY withdrawal_requests.user_id
), universe AS (
  SELECT wallets.user_id FROM wallets
  UNION
  SELECT buckets.user_id FROM buckets
  UNION
  SELECT holds.user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(
    0::numeric,
    LEAST(
      COALESCE(w.withdrawable_balance, 0::numeric),
      GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric))
        + GREATEST(0::numeric, COALESCE(w.withdrawable_balance, 0::numeric) - GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric)))
    ) - COALESCE(h.pending_holds, 0::numeric)
  ) AS withdrawable,
  -- Float: trust the wallets cache (maintained only by apply_wallet_movement,
  -- the ledger-driven sole writer). Pre-anchor float deposits are still real
  -- even when the post-anchor ledger window only sees the consumption side.
  GREATEST(0::numeric, COALESCE(w.float_balance, 0::numeric)) AS float_balance,
  -- Advance: same rationale — trust the wallets cache.
  GREATEST(0::numeric, COALESCE(w.advance_balance, 0::numeric)) AS advance_balance,
  COALESCE(h.pending_holds, 0::numeric) AS pending_holds,
  GREATEST(
    0::numeric,
    LEAST(
      COALESCE(w.withdrawable_balance, 0::numeric),
      GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric))
        + GREATEST(0::numeric, COALESCE(w.withdrawable_balance, 0::numeric) - GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric)))
    ) - COALESCE(h.pending_holds, 0::numeric)
  ) + GREATEST(0::numeric, COALESCE(w.float_balance, 0::numeric)) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds   h ON h.user_id = u.user_id
LEFT JOIN wallets w ON w.user_id = u.user_id;