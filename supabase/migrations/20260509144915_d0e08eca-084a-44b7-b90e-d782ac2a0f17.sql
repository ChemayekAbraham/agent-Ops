-- 1) Extend agent-aware routing: agent system_balance_correction debits should hit FLOAT
--    (same bucket where wallet_transfer credits land for agents) so CFO offsetting
--    pairs (transfer-in + correction-out) wash inside one bucket instead of inflating float
--    while pushing withdrawable negative.
CREATE OR REPLACE FUNCTION public.wallet_route_for_category(p_user_id uuid, p_category text, p_direction text)
 RETURNS TABLE(bucket text, sign integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sign int;
  v_is_agent boolean := false;
BEGIN
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_user_id
        AND role = 'agent'
        AND COALESCE(enabled, true) = true
    ) INTO v_is_agent;
  END IF;

  -- Agent credits routed to FLOAT
  IF v_is_agent AND v_sign = 1 AND p_category IN (
    'wallet_transfer',
    'cfo_direct_credit','system_balance_correction',
    'roi_wallet_credit','roi_payout',
    'pool_capital_received','partner_funding',
    'supporter_capital','supporter_rent_fund',
    'manager_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, 1;
    RETURN;
  END IF;

  -- Agent debits routed to FLOAT (now includes system_balance_correction so CFO
  -- offsetting entries against float-routed credits don't bleed into withdrawable)
  IF v_is_agent AND v_sign = -1 AND p_category IN (
    'agent_proxy_investment','coo_proxy_investment',
    'pending_portfolio_topup','proxy_partner_withdrawal',
    'wallet_transfer','rent_payment_for_tenant','rent_obligation',
    'system_balance_correction','cfo_direct_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, -1;
    RETURN;
  END IF;

  RETURN QUERY SELECT * FROM public.wallet_route_for_category(p_category, p_direction);
END;
$function$;

-- 2) Replace the wallet pivot view to drive bucket assignment off the routing function
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
    AND NOT (
      COALESCE(gl.classification, '') = 'admin_correction'
      AND COALESCE(gl.category, '')  = 'system_balance_correction'
    )
),
routed AS (
  SELECT l.user_id, l.amount, r.bucket, r.sign
  FROM ledger l
  CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) r
),
buckets AS (
  SELECT
    user_id,
    SUM(CASE WHEN bucket = 'withdrawable' THEN sign * amount ELSE 0 END) AS withdrawable_raw,
    SUM(CASE WHEN bucket = 'float'        THEN sign * amount ELSE 0 END) AS float_raw,
    SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment')
             THEN sign * amount ELSE 0 END)                                AS advance_raw
  FROM routed
  GROUP BY user_id
),
holds AS (
  SELECT user_id, COALESCE(SUM(amount), 0) AS pending_holds
  FROM public.withdrawal_requests
  WHERE status = ANY (ARRAY['pending','requested','manager_approved','processing'])
  GROUP BY user_id
),
universe AS (
  SELECT user_id FROM public.wallets_physical
  UNION SELECT user_id FROM buckets
  UNION SELECT user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))         AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw, 0))                                                AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw, 0))                                              AS advance_balance,
  COALESCE(h.pending_holds, 0)                                                         AS pending_holds,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))
    + GREATEST(0, COALESCE(b.float_raw, 0))                                            AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds   h ON h.user_id = u.user_id;

-- 3) Verification: Onesmus must read float = 498,000 (650k float deposits − 152k tenant payment),
--    and withdrawable must include the new 15,200 commission. Pair-offsetting CFO entries
--    must wash to zero inside float.
DO $$
DECLARE v_w numeric; v_f numeric;
BEGIN
  SELECT withdrawable, float_balance INTO v_w, v_f
  FROM public.v_user_wallet_strict
  WHERE user_id = 'e3cf4d3a-d021-49e4-b815-7e1938166eeb';

  IF v_f <> 498000 THEN
    RAISE EXCEPTION 'Float verification failed for Onesmus: float=% (expected 498000)', v_f;
  END IF;

  IF v_w < 15200 THEN
    RAISE EXCEPTION 'Withdrawable verification failed for Onesmus: withdrawable=% (expected at least 15200)', v_w;
  END IF;
END $$;