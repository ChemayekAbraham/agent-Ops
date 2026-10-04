CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _withdrawable_raw numeric := 0;
  _holds            numeric := 0;
  _anchor_at        timestamptz;
  _is_agent         boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Resolve fresh-start anchor and agent role ONCE (the view re-checked the
  -- agent role per ledger row across every user, which is what timed out).
  SELECT anchor_at INTO _anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id
  ORDER BY anchor_at DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id
      AND role = 'agent'
      AND COALESCE(enabled, true) = true
  ) INTO _is_agent;

  -- Withdrawable bucket, scoped to this single user. Mirrors v_user_wallet_strict
  -- routing exactly: explicit wallet_bucket wins; NULL buckets route by category
  -- (agent-specific overrides first, then the shared category map).
  SELECT COALESCE(SUM(
           CASE
             WHEN gl.direction IN ('cash_in','credit')  THEN  1
             WHEN gl.direction IN ('cash_out','debit')  THEN -1
             ELSE 0
           END * gl.amount
         ), 0)
    INTO _withdrawable_raw
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
    AND (_anchor_at IS NULL OR gl.created_at >= _anchor_at)
    AND (
      -- Explicit bucket = withdrawable
      gl.wallet_bucket = 'withdrawable'
      OR (
        -- Category-routed (only rows with NULL wallet_bucket are routed)
        gl.wallet_bucket IS NULL
        -- Exclude agent credit -> float overrides
        AND NOT (
          _is_agent
          AND gl.direction IN ('cash_in','credit')
          AND gl.category IN (
            'cfo_direct_credit','pool_capital_received','partner_funding',
            'supporter_capital','supporter_rent_fund','manager_credit'
          )
        )
        -- Exclude agent debit -> float overrides
        AND NOT (
          _is_agent
          AND gl.direction IN ('cash_out','debit')
          AND gl.category IN (
            'agent_proxy_investment','coo_proxy_investment',
            'pending_portfolio_topup','proxy_partner_withdrawal',
            'rent_payment_for_tenant','rent_obligation','cfo_direct_credit'
          )
        )
        -- Exclude shared float categories
        AND gl.category NOT IN (
          'agent_float_deposit','agent_float_assignment','agent_float_topup',
          'agent_float_funding','agent_float_used_for_rent','agent_float_used',
          'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
        )
        -- Exclude advance buckets
        AND NOT (
          gl.category IN ('agent_advance_credit','salary_advance')
          AND gl.direction IN ('cash_in','credit')
        )
        AND NOT (
          gl.category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery')
          AND gl.direction IN ('cash_out','debit')
        )
      )
    );

  -- Pending holds (same proxy-agent mapping + reason filter as the view).
  SELECT COALESCE(SUM(wr.amount), 0)
    INTO _holds
  FROM public.withdrawal_requests wr
  WHERE wr.status IN ('pending','requested','manager_approved','processing')
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id;

  RETURN GREATEST(0, COALESCE(_withdrawable_raw, 0) - COALESCE(_holds, 0));
END;
$function$;