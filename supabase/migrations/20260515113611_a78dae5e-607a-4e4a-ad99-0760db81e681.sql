-- Remove wallet_transfer from agent-→-float overrides so W2W always lands in
-- the recipient's withdrawable bucket (matches recipient_type='user' intent).
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

  -- Agent credits routed to FLOAT.
  -- 'wallet_transfer' REMOVED (2026-05-15): person-to-person wallet transfers
  -- are user-funds (recipient_type='user') and must land in withdrawable, even
  -- when the recipient also wears the agent hat. Forcing W2W into float made
  -- transferred money non-withdrawable.
  IF v_is_agent AND v_sign = 1 AND p_category IN (
    'cfo_direct_credit',
    'pool_capital_received','partner_funding',
    'supporter_capital','supporter_rent_fund',
    'manager_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, 1;
    RETURN;
  END IF;

  -- Agent debits routed to FLOAT
  -- 'wallet_transfer' REMOVED (2026-05-15): see comment above.
  IF v_is_agent AND v_sign = -1 AND p_category IN (
    'agent_proxy_investment','coo_proxy_investment',
    'pending_portfolio_topup','proxy_partner_withdrawal',
    'rent_payment_for_tenant','rent_obligation',
    'cfo_direct_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, -1;
    RETURN;
  END IF;

  RETURN QUERY SELECT * FROM public.wallet_route_for_category(p_category, p_direction);
END;
$function$;

-- Backfill: re-pivot weliledowry's wallet under the new rule.
-- Re-trigger pivot by inserting a no-op admin marker is invasive; instead
-- recompute the cached buckets directly from ledger truth using the same
-- logic as tg_ledger_pivot_apply.
DO $$
DECLARE
  r RECORD;
  v_w numeric; v_f numeric; v_a numeric;
  v_anchor_at timestamptz;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  FOR r IN
    SELECT DISTINCT gl.user_id
    FROM public.general_ledger gl
    WHERE gl.ledger_scope = 'wallet'
      AND gl.category = 'wallet_transfer'
      AND gl.user_id IN (
        SELECT user_id FROM public.user_roles
        WHERE role = 'agent' AND COALESCE(enabled,true) = true
      )
  LOOP
    SELECT anchor_at INTO v_anchor_at
      FROM public.wallet_fresh_start_anchors WHERE user_id = r.user_id LIMIT 1;

    WITH ledger AS (
      SELECT gl.category, gl.direction, gl.amount
      FROM public.general_ledger gl
      WHERE gl.user_id = r.user_id
        AND gl.ledger_scope = 'wallet'
        AND (gl.classification IS NULL OR gl.classification = 'production')
        AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
        AND NOT (
          COALESCE(gl.classification,'') = 'admin_correction'
          AND COALESCE(gl.category,'') = 'system_balance_correction'
        )
    ),
    routed AS (
      SELECT l.amount, rt.bucket, rt.sign
      FROM ledger l
      CROSS JOIN LATERAL public.wallet_route_for_category(r.user_id, l.category, l.direction) rt(bucket, sign)
    )
    SELECT
      COALESCE(SUM(CASE WHEN bucket='withdrawable' THEN sign::numeric*amount ELSE 0 END),0),
      COALESCE(SUM(CASE WHEN bucket='float' THEN sign::numeric*amount ELSE 0 END),0),
      COALESCE(SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign::numeric*amount ELSE 0 END),0)
    INTO v_w, v_f, v_a FROM routed;

    UPDATE public.wallets
       SET withdrawable_balance = GREATEST(0, v_w),
           float_balance = GREATEST(0, v_f),
           advance_balance = GREATEST(0, -v_a),
           balance = GREATEST(0, v_w) + GREATEST(0, v_f),
           updated_at = now()
     WHERE user_id = r.user_id;

    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (r.user_id, 'withdrawable', v_w, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum=EXCLUDED.balance_sum, last_updated_at=now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (r.user_id, 'float', v_f, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum=EXCLUDED.balance_sum, last_updated_at=now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (r.user_id, 'advance', v_a, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum=EXCLUDED.balance_sum, last_updated_at=now();
  END LOOP;
END $$;