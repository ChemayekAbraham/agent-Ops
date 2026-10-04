-- =====================================================================
-- Hybrid wallet model v2: cache stays for ops, user-facing view is ledger-only
-- =====================================================================
-- general_ledger has no `recipient_type` column. Buckets are inferred
-- from `category`, exactly as `get_user_available_balance` already does.
--
-- Withdrawable = wallet-scope ledger net
--                MINUS float-bucket categories
--                MINUS admin corrections
--                MINUS pending withdrawal holds
--                clamped at 0.
--
-- Float        = wallet-scope ledger net of float-bucket categories only.
-- Advance      = liability bucket (advance_* categories).
-- Honors per-user wallet_fresh_start_anchors window.
-- =====================================================================

CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
),
ledger AS (
  SELECT
    gl.user_id,
    gl.category,
    gl.direction,
    gl.amount
  FROM public.general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification = 'production' OR gl.classification = 'legacy_real')
    AND gl.category <> 'system_balance_correction'
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
),
buckets AS (
  SELECT
    user_id,
    -- Withdrawable: everything EXCEPT float categories and advance categories
    SUM(
      CASE
        WHEN COALESCE(category, '') NOT IN (
               'agent_float_deposit',
               'agent_float_used_for_rent',
               'agent_float_settlement',
               'agent_float_assignment',
               'rent_float_funding',
               'partner_funding'
             )
         AND COALESCE(category, '') NOT LIKE 'advance_%'
        THEN CASE WHEN direction = 'cash_in'  THEN amount
                  WHEN direction = 'cash_out' THEN -amount
                  ELSE 0 END
        ELSE 0
      END
    )::numeric AS withdrawable_raw,
    -- Float: float-bucket categories
    SUM(
      CASE
        WHEN COALESCE(category, '') IN (
               'agent_float_deposit',
               'agent_float_used_for_rent',
               'agent_float_settlement',
               'agent_float_assignment',
               'rent_float_funding',
               'partner_funding'
             )
        THEN CASE WHEN direction = 'cash_in'  THEN amount
                  WHEN direction = 'cash_out' THEN -amount
                  ELSE 0 END
        ELSE 0
      END
    )::numeric AS float_raw,
    -- Advance: liability bucket
    SUM(
      CASE
        WHEN COALESCE(category, '') LIKE 'advance_%'
        THEN CASE WHEN direction = 'cash_in'  THEN amount
                  WHEN direction = 'cash_out' THEN -amount
                  ELSE 0 END
        ELSE 0
      END
    )::numeric AS advance_raw
  FROM ledger
  GROUP BY user_id
),
holds AS (
  SELECT
    user_id,
    COALESCE(SUM(amount), 0)::numeric AS pending_holds
  FROM public.withdrawal_requests
  WHERE status IN ('pending', 'requested', 'manager_approved', 'processing')
  GROUP BY user_id
)
SELECT
  b.user_id,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))::numeric AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw, 0))::numeric                                       AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw, 0))::numeric                                     AS advance_balance,
  COALESCE(h.pending_holds, 0)::numeric                                                AS pending_holds,
  (
    GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))
    + GREATEST(0, COALESCE(b.float_raw, 0))
  )::numeric                                                                           AS total_visible
FROM buckets b
LEFT JOIN holds h ON h.user_id = b.user_id;

COMMENT ON VIEW public.v_user_wallet_strict IS
  'User-facing wallet truth. Computed live from general_ledger. Never reads wallets.* cache. Operator dashboards must keep using wallets table for reconciliation.';

-- ---------------------------------------------------------------------
-- RPC wrapper so the frontend can fetch the row as JSON in one call.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.v_user_wallet_strict%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL,
      'withdrawable', 0,
      'float_balance', 0,
      'advance_balance', 0,
      'pending_holds', 0,
      'total_visible', 0
    );
  END IF;

  SELECT * INTO v_row
  FROM public.v_user_wallet_strict
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'user_id', p_user_id,
      'withdrawable', 0,
      'float_balance', 0,
      'advance_balance', 0,
      'pending_holds', 0,
      'total_visible', 0
    );
  END IF;

  RETURN jsonb_build_object(
    'user_id',         v_row.user_id,
    'withdrawable',    v_row.withdrawable,
    'float_balance',   v_row.float_balance,
    'advance_balance', v_row.advance_balance,
    'pending_holds',   v_row.pending_holds,
    'total_visible',   v_row.total_visible
  );
END;
$$;

COMMENT ON FUNCTION public.get_user_wallet_view(uuid) IS
  'Returns the strict ledger-derived wallet view as JSON. The ONLY function user-facing wallet UIs should call. Operator dashboards keep using wallets.* directly.';

GRANT EXECUTE ON FUNCTION public.get_user_wallet_view(uuid) TO authenticated, anon, service_role;
GRANT SELECT ON public.v_user_wallet_strict TO authenticated, service_role;