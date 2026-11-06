-- Rollback of 20261104160000_merchandise_phase3b_controls: restores record_advance_deduction_atomic, get_partner_ops_returns_arrears and the allowlist (phase 3
-- definition) verbatim, drops the unrecorded-sale trigger and functions. STAY (append-only / evidence): the penalty
-- correction groups, the review table, and the agent_advance_memo_offset mapping while any leg uses it. The
-- recompute_wallet_buckets grants stay closed.
SET lock_timeout = '5s';
LOCK TABLE public.agent_advance_ledger IN EXCLUSIVE MODE;
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

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT ((public.ledger_category_allowlist_base() || ARRAY[
    'agent_advance_receivable_opening',
    'agent_access_fee_receivable_opening',
    'merchandise_recovery_receivable_opening',
    'bike_recovery_receivable_opening',
    'credit_draw_receivable_opening',
    'merchandise_credit_sale_receivable_opening',
    'service_centre_advance_receivable_opening',
    'service_centre_receivable_opening',
    'tenant_service_charge_receivable_opening',
    'business_advance_receivable_opening',
    'rent_plan_receivable_restatement',
    'receivable_restatement_equity',
    'merchandise_recovery_repayment',
    'bike_recovery_repayment',
    'credit_draw_repayment',
    'smartphone_advance_receivable',
    'agent_advance_disbursement',
    'agent_advance_access_fee_charged',
    'agent_advance_registration_fee_charged',
    'agent_advance_fee_revenue',
    'agent_advance_penalty_accrued',
    'agent_advance_penalty_unearned',
    'agent_advance_access_fee_collected',
    'agent_advance_registration_fee_collected',
    'agent_advance_written_off',
    'agent_advance_access_fee_written_off',
    'agent_advance_registration_fee_written_off',
    'agent_advance_reversed',
    'agent_advance_clawback',
    'agent_advance_late_fee_income',
    'agent_advance_access_fee_collected_external',
    'agent_advance_registration_fee_collected_external',
    'agent_advance_penalty_accrued_external',
    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_topup_self_support',
    'landlord_pool_topup_company_managed',
    'landlord_pool_compound_self_support',
    'landlord_pool_compound_company_managed',
    'landlord_pool_deploy_self_support',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_deploy_target',
    'landlord_pool_return_self_support',
    'landlord_pool_return_company_managed',
    'landlord_pool_return_source',
    'landlord_pool_release_self_support',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_target'
  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[]
    -- 2026-11-04 (CFO, merchandise phase 3): merchandise sales revenue (R1); offset of the advance shown on an agent's
    -- wallet for a phone bought by the company (L1 memo, not money owed to the agent)
    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']::text[];
$function$;

DROP TRIGGER trg_merch_unrecorded_sale ON public.merchandise_sales;
DROP FUNCTION public.trg_merch_unrecorded_sale();
DROP FUNCTION public._merch_unrecorded_sale_check(uuid, text);
DELETE FROM public.ledger_account_map m WHERE m.category = 'agent_advance_memo_offset'
  AND NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.category = m.category);
DO $post$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.record_advance_deduction_atomic(uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric, text, numeric, text, jsonb, text, jsonb)'))
       IS DISTINCT FROM 'a0b92c1cbf131b2050575c7658dfac1c'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_partner_ops_returns_arrears(uuid[])'))
       IS DISTINCT FROM 'f083c24dd1309f2acb6b93da67ef36b7'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()'))
       IS DISTINCT FROM '0cf8f4c90c5fc99832b276f8615a3423' THEN
    RAISE EXCEPTION 'rollback post-check failed';
  END IF;
END $post$;
