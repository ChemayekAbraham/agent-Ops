CREATE OR REPLACE FUNCTION public.agent_ops_shopping_advance_user_dossier(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ai_id text;
  v_qualified boolean;
  v_received_total numeric := 0;
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND COALESCE(ur.enabled, true)
      AND ur.role::text IN ('agent_ops','manager','super_admin','coo','ceo','operations')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.wallet_transactions wt
    WHERE wt.sender_id = p_user_id
      AND wt.sender_id IS DISTINCT FROM wt.recipient_id
      AND wt.amount > 0
    UNION ALL
    SELECT 1
    FROM public.general_ledger gl
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND gl.category = 'wallet_transfer'
      AND gl.direction = 'cash_out'
      AND gl.source_table = 'wallet_transactions'
      AND gl.amount > 0
  ) INTO v_qualified;

  IF NOT v_qualified THEN
    RAISE EXCEPTION 'user_not_shopping_advance_qualified';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id) THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  v_ai_id := public.derive_welile_ai_id(p_user_id);

  SELECT COALESCE(sum(wt.amount), 0)
  INTO v_received_total
  FROM public.wallet_transactions wt
  WHERE wt.recipient_id = p_user_id
    AND wt.sender_id IS DISTINCT FROM wt.recipient_id
    AND wt.amount > 0;

  SELECT jsonb_build_object(
    'profile', (
      SELECT jsonb_build_object(
        'id', p.id,
        'full_name', p.full_name,
        'phone', p.phone,
        'email', p.email,
        'national_id', p.national_id,
        'occupation', p.occupation,
        'primary_persona', p.primary_persona,
        'verified', p.verified,
        'phone_verified', p.phone_verified,
        'is_frozen', p.is_frozen,
        'created_at', p.created_at,
        'last_active_at', p.last_active_at,
        'location', nullif(concat_ws(', ', p.village, p.parish, p.sub_county, p.district, coalesce(p.region, p.city)), ''),
        'landmark', p.landmark,
        'mobile_money_provider', p.mobile_money_provider,
        'mobile_money_number', p.mobile_money_number,
        'roles', (SELECT COALESCE(jsonb_agg(DISTINCT ur.role::text), '[]'::jsonb) FROM public.user_roles ur WHERE ur.user_id = p.id AND COALESCE(ur.enabled, true))
      ) FROM public.profiles p WHERE p.id = p_user_id
    ),
    'qualification', (
      WITH transfer_rows AS (
        SELECT wt.amount::numeric amount, wt.created_at occurred_at
        FROM public.wallet_transactions wt
        WHERE wt.sender_id = p_user_id
          AND wt.sender_id IS DISTINCT FROM wt.recipient_id
          AND wt.amount > 0
        UNION ALL
        SELECT gl.amount::numeric, gl.transaction_date
        FROM public.general_ledger gl
        WHERE gl.user_id = p_user_id
          AND gl.ledger_scope = 'wallet'
          AND gl.category = 'wallet_transfer'
          AND gl.direction = 'cash_out'
          AND gl.source_table = 'wallet_transactions'
          AND gl.amount > 0
      )
      SELECT jsonb_build_object(
        'transfer_count', count(*),
        'transfer_total', COALESCE(sum(amount), 0),
        'first_transfer_at', min(occurred_at),
        'last_transfer_at', max(occurred_at),
        'received_transfer_total', v_received_total,
        'access_limit', LEAST(30000000::numeric, 30000::numeric + (v_received_total * 2))
      ) FROM transfer_rows
    ),
    'wallet', (
      SELECT jsonb_build_object(
        'available', wp.user_id IS NOT NULL,
        'withdrawable', CASE WHEN wp.user_id IS NULL THEN NULL ELSE public.get_user_available_balance(p_user_id) END,
        'operational_float', wp.float_balance,
        'advance_balance', wp.advance_balance,
        'pending_holds', wp.pending_holds,
        'updated_at', wp.updated_at
      ) FROM (SELECT 1) seed LEFT JOIN public.wallet_balances_projection wp ON wp.user_id = p_user_id
    ),
    'rent_plans', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT rr.id, rr.status, rr.rent_amount, rr.total_repayment, rr.amount_repaid,
          rr.daily_repayment, greatest(COALESCE(rr.total_repayment,0)-COALESCE(rr.amount_repaid,0),0) outstanding,
          rr.created_at, rr.funded_at, rr.tenancy_status, ap.full_name agent_name
        FROM public.rent_requests rr
        LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
        WHERE rr.tenant_id = p_user_id AND rr.status <> 'deleted_by_agent'
        LIMIT 200
      ) x
    ),
    'agent_advances', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT aa.id, aa.principal, aa.outstanding_balance, aa.arrears_balance, aa.installment_amount,
          aa.status, aa.issued_at, aa.expires_at, aa.created_at
        FROM public.agent_advances aa
        WHERE aa.agent_id = p_user_id
        LIMIT 100
      ) x
    ),
    'advance_requests', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT ar.id, ar.principal, ar.total_payable, ar.daily_payment, ar.status,
          ar.request_kind, ar.repayment_frequency, ar.created_at
        FROM public.agent_advance_requests ar
        WHERE ar.agent_id = p_user_id
        LIMIT 100
      ) x
    ),
    'business_advances', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT ba.id, ba.business_name, ba.principal, ba.outstanding_balance, ba.total_repaid,
          ba.status::text status, ba.created_at, ba.disbursed_at
        FROM public.business_advances ba
        WHERE ba.tenant_id = p_user_id OR ba.agent_id = p_user_id
        LIMIT 100
      ) x
    ),
    'obligations', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT o.id, o.amount, o.recovered_amount,
          greatest(COALESCE(o.amount,0)-COALESCE(o.recovered_amount,0),0) outstanding,
          o.reason, o.status, o.auto_recover, o.created_at
        FROM public.cfo_debit_obligations o
        WHERE o.user_id = p_user_id
        LIMIT 100
      ) x
    ),
    'portfolios', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT ip.id, ip.portfolio_code, ip.investment_amount, ip.duration_months,
          ip.roi_percentage returns_percentage, ip.roi_mode returns_mode, ip.status,
          ip.created_at, ip.maturity_date, ip.total_roi_earned total_returns_earned,
          ip.auto_reinvest
        FROM public.investor_portfolios ip
        WHERE ip.investor_id = p_user_id
        LIMIT 100
      ) x
    ),
    'shares', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT ai.id, ai.amount, ai.shares, ai.pool_ownership_percent,
          ai.company_ownership_percent, ai.status, ai.created_at, ai.funded_by
        FROM public.angel_pool_investments ai
        WHERE ai.investor_id = p_user_id
        LIMIT 100
      ) x
    ),
    'ai_id', v_ai_id,
    'trust_profile', public.get_user_trust_profile(v_ai_id)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_ops_shopping_advance_user_dossier(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_ops_shopping_advance_user_dossier(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_shopping_advance_user_dossier(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_shopping_advance_user_dossier(uuid) TO service_role;