CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at
  FROM public.wallet_fresh_start_anchors
),
ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount, gl.classification, gl.created_at
  FROM public.general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification = 'production')
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
    AND NOT (
      COALESCE(gl.classification, '') = 'admin_correction'
      AND COALESCE(gl.category, '') = 'system_balance_correction'
    )
),
buckets AS (
  SELECT
    user_id,
    SUM(
      CASE
        WHEN COALESCE(category, '') NOT IN (
          'agent_float_deposit',
          'agent_float_used_for_rent',
          'agent_float_settlement',
          'agent_float_assignment',
          'rent_float_funding',
          'partner_funding',
          'test_funds_cleanup',
          'historical_balance_reseed'
        )
        AND COALESCE(category, '') NOT LIKE 'advance_%'
        THEN CASE
          WHEN direction = 'cash_in' THEN amount
          WHEN direction = 'cash_out' THEN -amount
          ELSE 0::numeric
        END
        ELSE 0::numeric
      END
    ) AS withdrawable_raw,
    SUM(
      CASE
        WHEN COALESCE(category, '') IN (
          'agent_float_deposit',
          'agent_float_used_for_rent',
          'agent_float_settlement',
          'agent_float_assignment',
          'rent_float_funding',
          'partner_funding',
          'test_funds_cleanup'
        )
        THEN CASE
          WHEN direction = 'cash_in' THEN amount
          WHEN direction = 'cash_out' THEN -amount
          ELSE 0::numeric
        END
        ELSE 0::numeric
      END
    ) AS float_raw,
    SUM(
      CASE
        WHEN COALESCE(category, '') LIKE 'advance_%'
        THEN CASE
          WHEN direction = 'cash_in' THEN amount
          WHEN direction = 'cash_out' THEN -amount
          ELSE 0::numeric
        END
        ELSE 0::numeric
      END
    ) AS advance_raw
  FROM ledger
  GROUP BY user_id
),
holds AS (
  SELECT user_id, COALESCE(SUM(amount), 0::numeric) AS pending_holds
  FROM public.withdrawal_requests
  WHERE status = ANY (ARRAY['pending','requested','manager_approved','processing'])
  GROUP BY user_id
),
universe AS (
  SELECT user_id FROM public.wallets_physical
  UNION
  SELECT user_id FROM buckets
  UNION
  SELECT user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) AS withdrawable,
  GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS float_balance,
  GREATEST(0::numeric, COALESCE(b.advance_raw, 0::numeric)) AS advance_balance,
  COALESCE(h.pending_holds, 0::numeric) AS pending_holds,
  GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(h.pending_holds, 0::numeric))
    + GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds h ON h.user_id = u.user_id;