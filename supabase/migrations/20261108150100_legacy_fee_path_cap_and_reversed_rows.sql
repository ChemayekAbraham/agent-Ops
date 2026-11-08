-- Fee recognition control on the older (proportional) fee path (CFO, 2026-11-08).
--
-- ACCOUNTING ONLY. No money, wallet, payment or collection is touched, and no existing ledger row changes. Applies to
-- collections allocated AFTER this migration; history is corrected separately by the approved correction script.
--
-- THE DEFECT
-- allocate_instalment (used by _post_rent_fee_collection_legacy and _post_instalment_waterfall_legacy) split every
-- shilling received pro-rata with NO CAP at the Rent Plan total, and its running total counted REVERSED allocations.
-- So a Rent Plan collected beyond its total kept recognising fee revenue past the fee it carries, and a reversed
-- collection kept inflating later splits. On 15-16 Sep 2026 that recognised UGX 890,537 of fees above three Rent Plans'
-- fees (Kakooza Charles: ba5f0105, b1fe09fa, f07f0bae).
-- The four-part split (four_part_v1, live since 29 Sep) already caps at the total and ignores reversed rows; it is not
-- changed here. No Rent Plan is on the older path today (0 active, read-only check 2026-11-08), but any Rent Plan that
-- fails is_four_part_waterfall_eligible() still routes to it, so the rule is fixed permanently.
--
-- THE RULE NOW
--   standing cash  = sum(instalment_amount - over_total_amount) over NON-REVERSED allocations
--   cumulative     = least(standing cash + this payment, Rent Plan basis total)
--   fees           = fee share at the cumulative, less fees already booked on non-reversed allocations (never negative,
--                    never more than the cash inside the total)
--   cash above the total is recorded on the allocation as over_total_amount, earns no fee, and is filed in
--   rent_fee_collection_exceptions ('collection_above_plan_total') for review, exactly as the four-part split does.
-- Agent commission accounting on the older waterfall (10% of the payment) is not changed here.
-- Same signatures, so grants (service_role only) are unchanged.
--
-- Rollback: supabase/rollbacks/20261108150100_legacy_fee_path_cap_and_reversed_rows.rollback.sql

CREATE OR REPLACE FUNCTION public.allocate_instalment(p_rent_request_id uuid, p_instalment_amount numeric)
 RETURNS TABLE(principal_component numeric, registration_fee_component numeric, access_fee_component numeric, cumulative_before numeric, cumulative_after numeric, basis_note text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amt numeric; v_prior_amt numeric; v_prior_rf numeric; v_prior_af numeric;
  v_basis numeric; v_cb numeric; v_ca numeric; v_in numeric; v_note text;
  t_rf numeric; t_af numeric; v_rf numeric; v_af numeric; d numeric;
BEGIN
  v_amt := ROUND(COALESCE(p_instalment_amount,0));

  -- Standing cash already split: reversed allocations and cash above the total do not count (2026-11-08).
  SELECT COALESCE(SUM(ia.instalment_amount - COALESCE(ia.over_total_amount,0)),0),
         COALESCE(SUM(ia.registration_fee_component),0), COALESCE(SUM(ia.access_fee_component),0)
    INTO v_prior_amt, v_prior_rf, v_prior_af
  FROM public.instalment_allocations ia
  WHERE ia.rent_request_id = p_rent_request_id AND ia.reversed_at IS NULL;

  -- Rent Plan basis total (stored total_repayment, or the component sum when that is missing or inconsistent).
  SELECT a.basis_total INTO v_basis FROM public.compute_instalment_allocation(p_rent_request_id, 1) a;
  IF COALESCE(v_basis, 0) <= 0 THEN v_basis := v_prior_amt + GREATEST(v_amt, 0); END IF;  -- nothing priced: all principal

  v_cb := LEAST(v_prior_amt, v_basis);
  IF v_amt <= 0 THEN
    RETURN QUERY SELECT 0::numeric,0::numeric,0::numeric,v_cb,v_cb,'non-positive instalment'::text;
    RETURN;
  END IF;
  v_ca := LEAST(v_prior_amt + v_amt, v_basis);
  v_in := GREATEST(v_ca - v_cb, 0);
  IF v_in <= 0 THEN
    RETURN QUERY SELECT 0::numeric,0::numeric,0::numeric,v_cb,v_cb,'above Rent Plan total - no fee'::text;
    RETURN;
  END IF;

  SELECT a.registration_fee_component, a.access_fee_component, a.basis_note
    INTO t_rf, t_af, v_note
  FROM public.compute_instalment_allocation(p_rent_request_id, v_ca) a;

  -- Fees: cumulative target less what non-reversed allocations already booked; never negative, never above the cash.
  v_rf := GREATEST(t_rf - v_prior_rf, 0);
  v_af := GREATEST(t_af - v_prior_af, 0);
  d := v_rf + v_af - v_in;
  IF d > 0 THEN
    v_af := v_af - LEAST(d, v_af); d := v_rf + v_af - v_in;
    IF d > 0 THEN v_rf := v_rf - LEAST(d, v_rf); END IF;
  END IF;

  RETURN QUERY SELECT (v_in - v_rf - v_af), v_rf, v_af, v_cb, v_ca, v_note;
END
$function$;

CREATE OR REPLACE FUNCTION public._post_rent_fee_collection_legacy(p_rent_request_id uuid, p_payment_amount numeric, p_source_table text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a record; v_inst uuid := gen_random_uuid(); v_grp uuid; v_fees numeric; v_key text; v_recog boolean; v_over numeric;
BEGIN
  IF p_rent_request_id IS NULL OR COALESCE(p_payment_amount,0) <= 0 THEN
    RETURN jsonb_build_object('status','no_op');
  END IF;
  IF NOT public.is_treasury_waterfall_scope(p_rent_request_id) THEN
    RETURN jsonb_build_object('status','out_of_scope_legacy');
  END IF;
  IF EXISTS (SELECT 1 FROM instalment_allocations ia
              WHERE ia.rent_request_id=p_rent_request_id AND ia.source_table=p_source_table
                AND ia.source_id=p_source_id) THEN
    RETURN jsonb_build_object('status','already_allocated');
  END IF;

  SELECT EXISTS (SELECT 1 FROM general_ledger gl
     WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
       AND gl.source_table='rent_requests' AND gl.source_id=p_rent_request_id) INTO v_recog;

  IF NOT v_recog THEN
    INSERT INTO rent_fee_collection_exceptions
      (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
    VALUES (p_rent_request_id, p_source_id, p_source_table, p_payment_amount,
            'funding_treasury_recognition_missing',
            jsonb_build_object(
              'note','Payment processed. Fee allocation and L7 drawdown skipped: no funding-side treasury_fee_recognised leg exists for this plan, so drawing down L7 would create a balance never recognised.',
              'remedy','Run recognise_funding_treasury() for this rent_request, then replay allocation for this collection.'))
    ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
    RETURN jsonb_build_object('status','skipped_no_funding_recognition');
  END IF;

  SELECT * INTO a FROM public.allocate_instalment(p_rent_request_id, p_payment_amount);
  -- 2026-11-08: cash above the Rent Plan total earns no fee; it is recorded on the allocation and filed for review.
  v_over := ROUND(p_payment_amount) - (COALESCE(a.principal_component,0)+COALESCE(a.registration_fee_component,0)
                                       +COALESCE(a.access_fee_component,0));
  IF v_over > 0 THEN
    INSERT INTO rent_fee_collection_exceptions
      (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
    VALUES (p_rent_request_id, p_source_id, p_source_table, ROUND(p_payment_amount), 'collection_above_plan_total',
      jsonb_build_object('amount_above_total', v_over, 'amount_within_total', ROUND(p_payment_amount) - v_over,
        'route', 'legacy_fee_path',
        'note', 'Cash above the approved Rent Plan total. No fee recognised on it. Nothing is reversed or refunded.'))
    ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
  END IF;
  IF (COALESCE(a.principal_component,0)+COALESCE(a.registration_fee_component,0)
      +COALESCE(a.access_fee_component,0)) <= 0 AND v_over <= 0 THEN
    RETURN jsonb_build_object('status','no_allocation');
  END IF;
  v_fees := COALESCE(a.registration_fee_component,0) + COALESCE(a.access_fee_component,0);

  INSERT INTO instalment_allocations
    (rent_request_id, instalment_id, instalment_amount, principal_component,
     registration_fee_component, access_fee_component,
     partner_reward_component, agent_commission_component, platform_net_component,
     source_table, source_id, over_total_amount)
  VALUES (p_rent_request_id, v_inst, ROUND(p_payment_amount),
          a.principal_component, a.registration_fee_component, a.access_fee_component,
          NULL, NULL, NULL, p_source_table, p_source_id, v_over);

  IF v_fees > 0 THEN
    v_key := 'rent-fee-collection:' || p_source_table || ':' || p_source_id::text;
    -- treasury_fee_drawdown is mapped L7/debit_when='cash_out', so a cash_out leg
    -- DEBITS L7. The two R1 fee categories are debit_when='cash_out', so cash_in
    -- legs CREDIT R1. Raw control: cash_out(fees) = cash_in(reg+access). Mapped
    -- control: DR L7 = CR R1. Both pass; neither R1 mapping is altered.
    SELECT public.create_ledger_transaction(
      entries := (
        jsonb_build_array(jsonb_build_object(
          'direction','cash_out','amount', v_fees, 'category','treasury_fee_drawdown',
          'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
          'reference_id',v_inst::text,'currency','UGX','transaction_date',now(),
          'description','Deferred fee revenue drawn down on tenant rent collection'))
        || CASE WHEN COALESCE(a.registration_fee_component,0) > 0 THEN
             jsonb_build_array(jsonb_build_object(
               'direction','cash_in','amount', a.registration_fee_component,
               'category','registration_fee_collected','ledger_scope','platform',
               'source_table',p_source_table,'source_id',p_source_id::text,
               'reference_id',v_inst::text,'currency','UGX','transaction_date',now(),
               'description','Registration fee collected from tenant rent payment'))
           ELSE '[]'::jsonb END
        || CASE WHEN COALESCE(a.access_fee_component,0) > 0 THEN
             jsonb_build_array(jsonb_build_object(
               'direction','cash_in','amount', a.access_fee_component,
               'category','access_fee_collected','ledger_scope','platform',
               'source_table',p_source_table,'source_id',p_source_id::text,
               'reference_id',v_inst::text,'currency','UGX','transaction_date',now(),
               'description','Access fee collected from tenant rent payment'))
           ELSE '[]'::jsonb END
      ), idempotency_key := v_key) INTO v_grp;
    UPDATE instalment_allocations SET transaction_group_id = v_grp WHERE instalment_id = v_inst;
  END IF;

  RETURN jsonb_build_object('status','posted','instalment_id',v_inst,
    'transaction_group_id',v_grp,'payment_amount',ROUND(p_payment_amount),
    'principal',a.principal_component,'registration_fee_collected',a.registration_fee_component,
    'access_fee_collected',a.access_fee_component,'total_fees_collected',v_fees,'amount_above_total',v_over);
END;
$function$;

CREATE OR REPLACE FUNCTION public._post_instalment_waterfall_legacy(p_rent_request_id uuid, p_instalment_amount numeric, p_source_table text, p_source_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a RECORD; v_inst_id uuid := gen_random_uuid(); v_grp uuid;
  v_agent numeric; v_partner numeric; v_net numeric; v_r1 numeric;
  v_prior_agent numeric; v_prior_partner numeric;
  v_plan_partner numeric; v_plan_access numeric; v_cum_access numeric;
  v_p numeric; v_d int; v_key text; v_over numeric;
BEGIN
  SELECT rent_amount, duration_days, access_fee INTO v_p, v_d, v_plan_access
  FROM rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'rent_request % not found', p_rent_request_id; END IF;

  IF EXISTS (SELECT 1 FROM instalment_allocations ia
             WHERE ia.rent_request_id=p_rent_request_id
               AND ia.source_table=p_source_table AND ia.source_id=p_source_id) THEN
    RETURN jsonb_build_object('status','already_allocated');
  END IF;

  SELECT * INTO a FROM public.allocate_instalment(p_rent_request_id, p_instalment_amount);
  -- 2026-11-08: cash above the Rent Plan total earns no fee; filed for review, nothing posted for it.
  v_over := ROUND(p_instalment_amount) - (a.principal_component + a.registration_fee_component + a.access_fee_component);
  IF v_over > 0 THEN
    INSERT INTO rent_fee_collection_exceptions
      (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
    VALUES (p_rent_request_id, p_source_id, p_source_table, ROUND(p_instalment_amount), 'collection_above_plan_total',
      jsonb_build_object('amount_above_total', v_over, 'route', 'legacy_waterfall',
        'note', 'Cash above the approved Rent Plan total. No fee recognised on it. Nothing is reversed or refunded.'))
    ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
  END IF;
  IF (a.principal_component + a.registration_fee_component + a.access_fee_component) <= 0 THEN
    RETURN jsonb_build_object('status', CASE WHEN v_over > 0 THEN 'above_plan_total' ELSE 'no_allocation' END);
  END IF;

  SELECT COALESCE(SUM(ia.agent_commission_component),0), COALESCE(SUM(ia.partner_reward_component),0),
         COALESCE(SUM(ia.access_fee_component),0)
    INTO v_prior_agent, v_prior_partner, v_cum_access
  FROM instalment_allocations ia WHERE ia.rent_request_id = p_rent_request_id AND ia.reversed_at IS NULL;

  -- Fixed: 10% of THIS payment only (was ROUND(10% x cumulative of all split rows) - prior
  -- deposit-route commission, which re-paid commission on earlier agent-route cash).
  v_agent        := ROUND(ROUND(p_instalment_amount) * 0.10);
  v_plan_partner := ROUND(v_p * 0.15 * (v_d/30.0));
  v_cum_access   := v_cum_access + a.access_fee_component;
  v_partner      := CASE WHEN v_plan_access > 0
                         THEN ROUND(v_plan_partner * v_cum_access / v_plan_access) - v_prior_partner
                         ELSE 0 END;
  v_net          := a.access_fee_component - v_agent - v_partner;
  v_r1           := a.access_fee_component + a.registration_fee_component - v_agent;
  v_key          := COALESCE(p_idempotency_key, 'waterfall:'||p_rent_request_id::text||':'||v_inst_id::text);

  INSERT INTO instalment_allocations
    (rent_request_id, instalment_id, instalment_amount, principal_component,
     registration_fee_component, access_fee_component, partner_reward_component,
     agent_commission_component, platform_net_component, source_table, source_id, over_total_amount)
  VALUES (p_rent_request_id, v_inst_id, ROUND(p_instalment_amount), a.principal_component,
          a.registration_fee_component, a.access_fee_component, v_partner, v_agent, v_net,
          p_source_table, p_source_id, v_over);

  SELECT public.create_ledger_transaction(
    entries := (
      jsonb_build_array(jsonb_build_object(
        'direction','cash_in','amount', a.access_fee_component + a.registration_fee_component,
        'category','treasury_allocated','ledger_scope','platform','source_table',p_source_table,
        'source_id',p_source_id::text,'reference_id',v_inst_id::text,'currency','UGX',
        'transaction_date',now(),'description','Treasury allocated for instalment'))
      || CASE WHEN v_agent > 0 THEN jsonb_build_array(jsonb_build_object(
          'direction','cash_out','amount', v_agent,'category','agent_commission_accrued',
          'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
          'reference_id',v_inst_id::text,'currency','UGX','transaction_date',now(),
          'description','Agent commission accrued (10%) on instalment')) ELSE '[]'::jsonb END
      || CASE WHEN v_r1 <> 0 THEN jsonb_build_array(jsonb_build_object(
          'direction', CASE WHEN v_r1 > 0 THEN 'cash_out' ELSE 'cash_in' END,
          'amount', abs(v_r1),'category','treasury_net_revenue','ledger_scope','platform',
          'source_table',p_source_table,'source_id',p_source_id::text,'reference_id',v_inst_id::text,
          'currency','UGX','transaction_date',now(),
          'description', CASE WHEN v_r1 > 0 THEN 'Platform revenue from Treasury allocation'
                              ELSE 'Contra-revenue: pricing subsidy on underpriced plan' END)) ELSE '[]'::jsonb END
    ), idempotency_key := v_key) INTO v_grp;

  UPDATE instalment_allocations SET transaction_group_id = v_grp WHERE instalment_id = v_inst_id;

  RETURN jsonb_build_object('status','posted','instalment_id',v_inst_id,'transaction_group_id',v_grp,
    'principal',a.principal_component,'registration',a.registration_fee_component,
    'access',a.access_fee_component,'partner_reward_allocation',v_partner,
    'agent_commission',v_agent,'platform_net',v_net,'r1_amount',v_r1);
END $function$;
