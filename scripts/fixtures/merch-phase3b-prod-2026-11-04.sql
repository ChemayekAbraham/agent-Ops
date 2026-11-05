-- Verbatim production copies (2026-11-04, read-only export via pg_get_functiondef, project byrzshwlentqvktcksem) for the
-- phase 3b tests in src/test/merchandisePhase3.test.ts. md5(prosrc):
--   record_advance_deduction_atomic          a0b92c1cbf131b2050575c7658dfac1c
--   get_partner_ops_returns_arrears          f083c24dd1309f2acb6b93da67ef36b7
--   recompute_wallet_buckets                 05c9a7562dd7178394db4eb46903aeff

CREATE OR REPLACE FUNCTION public.record_advance_deduction_atomic(p_advance_id uuid, p_agent_id uuid, p_date date, p_opening_balance numeric, p_interest_accrued numeric, p_amount_deducted numeric, p_closing_balance numeric, p_deduction_status text, p_new_status text, p_new_fee_collected numeric, p_fee_status text, p_new_arrears numeric, p_penalty_description text DEFAULT NULL::text, p_penalty_meta jsonb DEFAULT '{}'::jsonb, p_repayment_description text DEFAULT NULL::text, p_repayment_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_penalty_group   uuid;
  v_repayment_group uuid;
  v_alloc           jsonb;
  v_funding         jsonb;
  v_current public.agent_advances%ROWTYPE;
BEGIN
  IF p_advance_id IS NULL OR p_agent_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'record_advance_deduction_atomic: advance, agent and date are required';
  END IF;
  PERFORM public._prepare_bike_priority(p_agent_id);
  SELECT * INTO v_current FROM public.agent_advances WHERE id=p_advance_id AND agent_id=p_agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance owner mismatch' USING ERRCODE='42501'; END IF;
  IF v_current.status NOT IN ('active','overdue') OR COALESCE(v_current.deduction_paused,false) OR COALESCE(v_current.recovery_source,'wallet_daily')='roi' THEN
    RAISE EXCEPTION 'BIKE_PRIORITY_RECALCULATE: Advance eligibility changed' USING ERRCODE='40001';
  END IF;
  IF p_opening_balance IS DISTINCT FROM v_current.outstanding_balance OR
    (p_repayment_meta ? 'expected_arrears' AND (p_repayment_meta->>'expected_arrears')::numeric IS DISTINCT FROM COALESCE(v_current.arrears_balance,0)) THEN
    RAISE EXCEPTION 'BIKE_PRIORITY_RECALCULATE: Advance changed; refresh recovery amounts' USING ERRCODE='40001';
  END IF;
  IF COALESCE(p_amount_deducted,0)>public._prepare_bike_priority(p_agent_id) THEN
    RAISE EXCEPTION 'BIKE_PRIORITY_RECALCULATE: Bike payment has priority; refresh recovery amounts' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, p_date, p_opening_balance, p_interest_accrued, p_amount_deducted,
     p_closing_balance, p_deduction_status);
  UPDATE public.agent_advances
  SET outstanding_balance  = GREATEST(0, p_closing_balance),
      status               = p_new_status,
      access_fee_collected = p_new_fee_collected,
      access_fee_status    = p_fee_status,
      arrears_balance      = p_new_arrears,
      updated_at           = now()
  WHERE id = p_advance_id;
  IF COALESCE(p_interest_accrued, 0) > 0 THEN
    IF public.agent_advance_is_post_effective(p_advance_id) THEN
      v_penalty_group := public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
            'amount', p_interest_accrued, 'category', 'agent_advance_penalty_accrued',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Late Fee accrued and capitalised into the advance',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          ),
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', p_interest_accrued, 'category', 'agent_advance_penalty_unearned',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Unearned Late Fee income held until collected',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          )
        ),
        idempotency_key => 'advance_late_fee:' || p_advance_id::text || ':' || p_date::text
      );
    ELSE
      v_penalty_group := public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
            'amount', p_interest_accrued, 'category', 'agent_advance_credit',
            'recipient_type', 'user', 'wallet_bucket', 'advance_credit',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', p_penalty_description,
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          ),
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
            'amount', p_interest_accrued, 'category', 'interest_expense',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Overdue advance penalty interest accrued (receivable)',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_penalty_meta
          )
        ),
        idempotency_key => 'advance_penalty_interest:' || p_advance_id::text || ':' || p_date::text
      );
    END IF;
  END IF;
  IF COALESCE(p_amount_deducted, 0) > 0 THEN
    v_funding := jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', p_amount_deducted, 'category', 'agent_repayment',
        'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', p_repayment_description,
        'currency', 'UGX', 'transaction_date', p_date,
        'metadata', p_repayment_meta
      ));
    v_alloc := public.agent_advance_allocation_entries(
                 p_advance_id, p_agent_id, p_amount_deducted, p_date::timestamptz, false);
    IF v_alloc IS NULL THEN
      v_repayment_group := public.create_ledger_transaction(
        entries => v_funding || jsonb_build_array(
          jsonb_build_object(
            'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', p_amount_deducted, 'category', 'agent_repayment',
            'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', p_advance_id,
            'description', 'Advance repayment received from agent',
            'currency', 'UGX', 'transaction_date', p_date,
            'metadata', p_repayment_meta
          ))
      );
    ELSE
      v_repayment_group := public.create_ledger_transaction(entries => v_funding || v_alloc);
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'amount_deducted', p_amount_deducted,
    'interest_accrued', p_interest_accrued,
    'closing_balance', GREATEST(0, p_closing_balance),
    'penalty_group_id', v_penalty_group,
    'repayment_group_id', v_repayment_group
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_partner_ops_returns_arrears(p_portfolio_ids uuid[])
 RETURNS TABLE(portfolio_id uuid, investor_id uuid, expected_returns numeric, pledge_mode text, pledge_value numeric, arrears_deduction numeric, net_payout numeric, plan_outstanding numeric, plan_overdue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.is_partner_ops(auth.uid()) OR public.can_view_staff_reports(auth.uid())) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH pf AS (
    SELECT ip.id, ip.investor_id AS owner_id, ip.created_at,
           round(COALESCE(ip.investment_amount, 0) * COALESCE(ip.roi_percentage, 15) / 100.0) AS expected
    FROM public.investor_portfolios ip
    WHERE ip.id = ANY (COALESCE(p_portfolio_ids, ARRAY[]::uuid[]))
  ),
  pledge AS (
    SELECT sp.user_id, sp.mode, sp.value
    FROM public.smartphone_roi_pledges sp
    WHERE sp.active
  ),
  plan AS (
    SELECT DISTINCT ON (p.customer_id)
           p.customer_id, p.outstanding_balance, COALESCE(p.due_balance, 0) AS overdue
    FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease, false) AND s.item_name ILIKE '%smartphone%'
    ORDER BY p.customer_id, p.created_at
  ),
  raw AS (
    SELECT pf.id, pf.owner_id, pf.created_at, pf.expected,
           pl.mode, pl.value, pn.outstanding_balance, pn.overdue,
           LEAST(
             CASE WHEN pl.mode = 'percent' THEN floor(pf.expected * pl.value / 100) ELSE pl.value END,
             pf.expected
           ) AS wanted
    FROM pf
    JOIN pledge pl ON pl.user_id = pf.owner_id
    JOIN plan pn ON pn.customer_id = pf.owner_id
  )
  SELECT r.id, r.owner_id, r.expected, r.mode, r.value,
         d.ded, r.expected - d.ded, r.outstanding_balance, r.overdue
  FROM raw r
  CROSS JOIN LATERAL (
    SELECT GREATEST(0, LEAST(
      r.wanted,
      r.outstanding_balance - COALESCE((
        SELECT sum(r2.wanted) FROM raw r2
        WHERE r2.owner_id = r.owner_id AND (r2.created_at, r2.id) < (r.created_at, r.id)
      ), 0)
    )) AS ded
  ) d
  ORDER BY r.owner_id, r.created_at, r.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.recompute_wallet_buckets(p_user_id uuid)
 RETURNS TABLE(withdrawable numeric, float_bal numeric, advance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_w numeric := 0;
  v_f numeric := 0;
  v_a numeric := 0;
  r record;
  v_route record;
  v_recover numeric;
BEGIN
  FOR r IN
    SELECT category, direction, amount
    FROM public.general_ledger
    WHERE user_id = p_user_id AND ledger_scope = 'wallet'
    ORDER BY created_at ASC, id ASC
  LOOP
    SELECT * INTO v_route FROM public.wallet_route_for_category(r.category, r.direction);
    IF v_route.bucket = 'withdrawable' AND v_route.sign = 1 THEN
      v_recover := LEAST(r.amount, v_a);
      v_a := v_a - v_recover;
      v_w := v_w + (r.amount - v_recover);
    ELSIF v_route.bucket = 'withdrawable' AND v_route.sign = -1 THEN
      v_w := v_w - r.amount;
    ELSIF v_route.bucket = 'float' AND v_route.sign = 1 THEN
      v_f := v_f + r.amount;
    ELSIF v_route.bucket = 'float' AND v_route.sign = -1 THEN
      v_f := v_f - r.amount;
    ELSIF v_route.bucket = 'advance_credit' THEN
      v_w := v_w + r.amount;
      v_a := v_a + r.amount;
    ELSIF v_route.bucket = 'advance_repayment' THEN
      v_w := v_w - r.amount;
      v_a := GREATEST(0, v_a - r.amount);
    END IF;
  END LOOP;

  v_w := GREATEST(0, v_w);
  v_f := GREATEST(0, v_f);
  v_a := GREATEST(0, v_a);

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.wallets_physical (user_id, currency)
  VALUES (p_user_id, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.wallets
    SET withdrawable_balance = v_w,
        float_balance = v_f,
        advance_balance = v_a,
        balance = v_w + v_f,
        updated_at = now()
    WHERE user_id = p_user_id;

  RETURN QUERY SELECT v_w, v_f, v_a;
END;
$function$;
