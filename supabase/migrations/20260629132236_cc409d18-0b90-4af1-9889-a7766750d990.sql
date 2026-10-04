CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor_at       timestamptz;
  v_is_agent        boolean := false;
  v_withdrawable_raw numeric := 0;
  v_float_raw       numeric := 0;
  v_advance_raw     numeric := 0;
  v_holds           numeric := 0;
  v_withdrawable    numeric := 0;
  v_float           numeric := 0;
  v_advance         numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0
    );
  END IF;

  -- Resolve anchor + agent role ONCE (was re-evaluated per ledger row per user).
  SELECT anchor_at INTO v_anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id
  ORDER BY anchor_at DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id AND role = 'agent' AND COALESCE(enabled, true) = true
  ) INTO v_is_agent;

  -- Single-user bucket aggregation, mirroring v_user_wallet_strict routing.
  WITH routed AS (
    SELECT
      CASE WHEN gl.direction IN ('cash_in','credit') THEN 1 ELSE -1 END AS sign,
      gl.amount,
      CASE
        WHEN gl.wallet_bucket IN ('withdrawable','float','advance_credit','advance_repayment')
          THEN gl.wallet_bucket
        WHEN gl.wallet_bucket IS NULL THEN
          CASE
            WHEN v_is_agent AND gl.direction IN ('cash_in','credit')
                 AND gl.category IN (
                   'cfo_direct_credit','pool_capital_received','partner_funding',
                   'supporter_capital','supporter_rent_fund','manager_credit'
                 ) THEN 'float'
            WHEN v_is_agent AND gl.direction IN ('cash_out','debit')
                 AND gl.category IN (
                   'agent_proxy_investment','coo_proxy_investment',
                   'pending_portfolio_topup','proxy_partner_withdrawal',
                   'rent_payment_for_tenant','rent_obligation','cfo_direct_credit'
                 ) THEN 'float'
            WHEN gl.category IN (
                   'agent_float_deposit','agent_float_assignment','agent_float_topup',
                   'agent_float_funding','agent_float_used_for_rent','agent_float_used',
                   'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
                 ) THEN 'float'
            WHEN gl.category IN ('agent_advance_credit','salary_advance')
                 AND gl.direction IN ('cash_in','credit') THEN 'advance_credit'
            WHEN gl.category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery')
                 AND gl.direction IN ('cash_out','debit') THEN 'advance_repayment'
            ELSE 'withdrawable'
          END
        ELSE NULL  -- non-null bucket outside the known set is excluded (matches view)
      END AS bucket
    FROM public.general_ledger gl
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND gl.direction IN ('cash_in','credit','cash_out','debit')
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction IN ('debit','cash_out')
        )
      )
      AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign * amount ELSE 0 END), 0)
  INTO v_withdrawable_raw, v_float_raw, v_advance_raw
  FROM routed;

  -- Pending holds (proxy-agent mapping + reason filter, same as the view).
  SELECT COALESCE(SUM(wr.amount), 0)
    INTO v_holds
  FROM public.withdrawal_requests wr
  WHERE wr.status IN ('pending','requested','manager_approved','processing')
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id;

  v_withdrawable := GREATEST(0, v_withdrawable_raw - v_holds);
  v_float        := GREATEST(0, v_float_raw);
  v_advance      := GREATEST(0, v_advance_raw);

  RETURN jsonb_build_object(
    'user_id',         p_user_id,
    'withdrawable',    v_withdrawable,
    'float_balance',   v_float,
    'advance_balance', v_advance,
    'pending_holds',   v_holds,
    'total_visible',   v_withdrawable + v_float
  );
END;
$function$;