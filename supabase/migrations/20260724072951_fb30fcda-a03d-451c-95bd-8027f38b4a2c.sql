CREATE OR REPLACE FUNCTION public.refresh_wallet_projection_for(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_withdrawable_raw numeric := 0;
  v_float_raw numeric := 0;
  v_advance_raw numeric := 0;
  v_restricted_held numeric := 0;
  v_pending_holds numeric := 0;
  v_withdrawable numeric := 0;
  v_float_balance numeric := 0;
  v_advance_balance numeric := 0;
  v_total_visible numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  WITH anchor AS (
    SELECT a.anchor_at
    FROM public.wallet_fresh_start_anchors a
    WHERE a.user_id = p_user_id
    LIMIT 1
  ), ledger AS (
    SELECT
      gl.user_id,
      gl.category,
      gl.direction,
      gl.amount,
      gl.wallet_bucket,
      gl.maturity_met,
      gl.maturity_expired,
      gl.withdrawable_after
    FROM public.general_ledger gl
    LEFT JOIN anchor a ON true
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction = ANY (ARRAY['debit','cash_out'])
        )
      )
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
  ), routed_explicit AS (
    SELECT
      l.user_id,
      l.amount,
      l.wallet_bucket AS bucket,
      CASE
        WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
        WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
        ELSE 0
      END AS sign,
      l.maturity_met,
      l.maturity_expired,
      l.withdrawable_after,
      l.direction,
      l.category
    FROM ledger l
    WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
  ), routed_category AS (
    SELECT
      l.user_id,
      l.amount,
      r.bucket,
      r.sign,
      l.maturity_met,
      l.maturity_expired,
      l.withdrawable_after,
      l.direction,
      l.category
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) AS r(bucket, sign)
    WHERE l.wallet_bucket IS NULL
  ), routed AS (
    SELECT * FROM routed_explicit
    UNION ALL
    SELECT * FROM routed_category
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN bucket = 'withdrawable'
       AND direction = ANY (ARRAY['cash_in','credit'])
       AND (
         maturity_expired = true
         OR (maturity_met = false AND now() <= COALESCE(withdrawable_after, now()))
       )
      THEN amount
      ELSE 0
    END), 0)
  INTO v_withdrawable_raw, v_float_raw, v_advance_raw, v_restricted_held
  FROM routed;

  SELECT COALESCE(SUM(wr.amount), 0)
  INTO v_pending_holds
  FROM public.withdrawal_requests wr
  WHERE (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id
    AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND NOT EXISTS (
      SELECT 1
      FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests'
        AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet'
        AND g.direction = ANY (ARRAY['cash_out','debit'])
    );

  v_withdrawable := GREATEST(0, v_withdrawable_raw - v_restricted_held - v_pending_holds);
  v_float_balance := GREATEST(0, v_float_raw);
  v_advance_balance := GREATEST(0, v_advance_raw);
  v_total_visible := v_withdrawable + v_float_balance;

  INSERT INTO public.wallet_balances_projection AS w (
    user_id,
    withdrawable,
    float_balance,
    advance_balance,
    pending_holds,
    restricted_held,
    total_visible,
    ledger_version,
    updated_at
  ) VALUES (
    p_user_id,
    v_withdrawable,
    v_float_balance,
    v_advance_balance,
    v_pending_holds,
    v_restricted_held,
    v_total_visible,
    1,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET withdrawable = EXCLUDED.withdrawable,
        float_balance = EXCLUDED.float_balance,
        advance_balance = EXCLUDED.advance_balance,
        pending_holds = EXCLUDED.pending_holds,
        restricted_held = EXCLUDED.restricted_held,
        total_visible = EXCLUDED.total_visible,
        ledger_version = w.ledger_version + 1,
        updated_at = now();
END;
$$;