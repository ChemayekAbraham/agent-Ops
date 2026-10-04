CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
),
ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount
  FROM public.general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification = 'production')
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
),
buckets AS (
  SELECT
    ledger.user_id,
    SUM(CASE
      WHEN COALESCE(ledger.category, '') NOT IN (
        'agent_float_deposit',
        'agent_float_used_for_rent',
        'agent_float_settlement',
        'agent_float_assignment',
        'rent_float_funding',
        'partner_funding',
        'test_funds_cleanup',
        'historical_balance_reseed',
        'system_balance_correction'
      )
      AND COALESCE(ledger.category, '') NOT LIKE 'advance_%'
      THEN CASE
        WHEN ledger.direction = 'cash_in' THEN ledger.amount
        WHEN ledger.direction = 'cash_out' THEN -ledger.amount
        ELSE 0
      END
      ELSE 0
    END) AS withdrawable_raw,
    SUM(CASE
      WHEN COALESCE(ledger.category, '') IN (
        'agent_float_deposit',
        'agent_float_used_for_rent',
        'agent_float_settlement',
        'agent_float_assignment',
        'rent_float_funding',
        'partner_funding',
        'test_funds_cleanup'
      )
      THEN CASE
        WHEN ledger.direction = 'cash_in' THEN ledger.amount
        WHEN ledger.direction = 'cash_out' THEN -ledger.amount
        ELSE 0
      END
      ELSE 0
    END) AS float_raw,
    SUM(CASE
      WHEN COALESCE(ledger.category, '') LIKE 'advance_%'
      THEN CASE
        WHEN ledger.direction = 'cash_in' THEN ledger.amount
        WHEN ledger.direction = 'cash_out' THEN -ledger.amount
        ELSE 0
      END
      ELSE 0
    END) AS advance_raw
  FROM ledger
  GROUP BY ledger.user_id
),
holds AS (
  SELECT user_id, COALESCE(SUM(amount), 0) AS pending_holds
  FROM public.withdrawal_requests
  WHERE status IN ('pending', 'requested', 'manager_approved', 'processing')
  GROUP BY user_id
),
universe AS (
  SELECT user_id FROM public.wallets_physical
  UNION SELECT user_id FROM buckets
  UNION SELECT user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0)) AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw, 0)) AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw, 0)) AS advance_balance,
  COALESCE(h.pending_holds, 0) AS pending_holds,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))
    + GREATEST(0, COALESCE(b.float_raw, 0)) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds h ON h.user_id = u.user_id;

CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _ledger_net_now numeric := 0;
  _pending_holds numeric := 0;
  _anchor_at timestamptz;
BEGIN
  SELECT anchor_at INTO _anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(CASE
      WHEN direction = 'cash_in' THEN amount
      WHEN direction = 'cash_out' THEN -amount
      ELSE 0
    END), 0)
    INTO _ledger_net_now
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production')
    AND (_anchor_at IS NULL OR created_at >= _anchor_at)
    AND COALESCE(category, '') NOT IN (
      'agent_float_deposit',
      'agent_float_used_for_rent',
      'agent_float_settlement',
      'agent_float_assignment',
      'rent_float_funding',
      'partner_funding',
      'test_funds_cleanup',
      'historical_balance_reseed',
      'system_balance_correction'
    )
    AND COALESCE(category, '') NOT LIKE 'advance_%';

  SELECT COALESCE(SUM(amount), 0)
    INTO _pending_holds
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND status IN ('pending', 'requested', 'manager_approved', 'processing');

  RETURN GREATEST(0, GREATEST(0, _ledger_net_now) - COALESCE(_pending_holds, 0));
END;
$function$;

GRANT SELECT ON public.v_user_wallet_strict TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_available_balance(uuid) TO authenticated, service_role;

COMMENT ON VIEW public.v_user_wallet_strict IS 'Strict ledger-backed wallet buckets. Reconciliation/repair categories are excluded from withdrawable so historical repairs cannot recreate deductible balances.';
COMMENT ON FUNCTION public.get_user_available_balance(uuid) IS 'Returns deductible UGX balance from production wallet ledger only, excluding float, advances, pending holds, and reconciliation/repair categories.';