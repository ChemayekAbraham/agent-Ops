-- Phase 2: all funder capital deployment draws operational float, tagged for audit.

-- 1) One definition of deployable float (DRY; single round trip for callers).
CREATE OR REPLACE FUNCTION public.funder_float_capacity(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.funder_float_available(p_user_id);
$$;

REVOKE ALL ON FUNCTION public.funder_float_capacity(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.funder_float_capacity(uuid) FROM authenticated, anon;

-- 2) Funder-created ordinary portfolio: gate on operational float.
CREATE OR REPLACE FUNCTION public.funder_create_pending_portfolio(
  p_amount numeric,
  p_summary_id uuid DEFAULT NULL::uuid,
  p_term_months integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_available numeric;
  v_reserved numeric;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF NOT public.funder_has_signed_agreement(v_uid) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'Sign your partner agreement before creating a portfolio.';
  END IF;

  PERFORM public.assert_no_promissory_self_support(v_uid, 'funder_create_pending_portfolio');

  IF COALESCE(p_amount,0) < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('funder-pending-' || v_uid::text));

  -- Operational float, already net of portfolios awaiting approval.
  v_available := public.funder_float_capacity(v_uid);
  v_reserved  := GREATEST(0, public.funder_pending_hold(v_uid));

  IF p_amount > v_available THEN
    RAISE EXCEPTION 'Your operational float has UGX % available (UGX % already awaiting approval).',
      round(GREATEST(v_available, 0)), round(v_reserved)
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_uid ORDER BY created_at LIMIT 1;

  v_code := 'WPF-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_uid, COALESCE(v_agent, v_uid), v_code, p_amount,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60)),
    15, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, summary_id, term_months
  ) VALUES (
    v_portfolio_id, v_uid, p_amount, 'rent_pool', p_summary_id,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60))
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_uid, 'funder_pending_portfolio_created', 'investor_portfolios', v_portfolio_id,
    jsonb_build_object('reason','funder_created_pending_portfolio_awaiting_ops','amount',p_amount,
                       'funding_source','operational_float',
                       'float_usage','portfolio_funding',
                       'float_available_before', v_available));

  RETURN jsonb_build_object(
    'portfolio_id', v_portfolio_id,
    'portfolio_code', v_code,
    'status', 'pending_ops_approval',
    'amount', p_amount,
    'funding_source', 'operational_float',
    'available_balance', public.funder_float_capacity(v_uid)
  );
END;
$function$;

-- 3) Approval of an ordinary / Partner-Ops-created portfolio: debit float, tagged.
DO $patch$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'approve_pending_portfolio' AND pronargs = 1;
  IF v_src IS NULL THEN RAISE EXCEPTION 'approve_pending_portfolio not found'; END IF;

  v_new := replace(
    v_src,
    $q$'recipient_type', 'user', 'wallet_bucket', 'withdrawable',$q$,
    $q$'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',$q$
  );
  v_new := replace(
    v_new,
    $q$'description', 'Partner rent pool funding approved by Partner Ops'$q$,
    $q$'description', 'Partner rent pool funding approved by Partner Ops (rent_pool; float_usage=portfolio_funding)'$q$
  );

  IF v_new = v_src THEN
    RAISE NOTICE 'approve_pending_portfolio already patched or shape changed';
  ELSE
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L',
      v_new
    );
  END IF;
END
$patch$;

-- 4) Portfolios that go live immediately (creation trigger): debit float, tagged.
DO $patch2$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'enforce_portfolio_funding_at_creation';
  IF v_src IS NULL THEN RAISE EXCEPTION 'enforce_portfolio_funding_at_creation not found'; END IF;

  v_new := replace(
    v_src,
    $q$'recipient_type', 'user',$q$,
    $q$'recipient_type', 'operational_wallet',
        'wallet_bucket', 'float',$q$
  );
  v_new := replace(
    v_new,
    $q$(auto — creation trigger)$q$,
    $q$(auto — creation trigger; float_usage=portfolio_funding)$q$
  );

  IF v_new = v_src THEN
    RAISE NOTICE 'enforce_portfolio_funding_at_creation already patched or shape changed';
  ELSE
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.enforce_portfolio_funding_at_creation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L',
      v_new
    );
  END IF;
END
$patch2$;