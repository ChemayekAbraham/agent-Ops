-- STAGED, NOT APPLIED. Private-copy tested 2026-09-29. Do not apply without approval.
-- Also blocked by live constraint instalment_allocations.access_split_reconciles (see principal-accounting-destination.md).
CREATE OR REPLACE FUNCTION public._post_four_part_fee_split(p_rent_request_id uuid, p_amount numeric, p_source_table text, p_source_id uuid, p_route text, p_commission_paid numeric DEFAULT NULL::numeric, p_idempotency_key text DEFAULT NULL::text, p_journal_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rr numeric; v_tt numeric; v_rf numeric; v_af numeric;
  v_comm_t numeric; v_part_t numeric; v_plat_t numeric;
  v_amt numeric; v_prior numeric; v_cb numeric; v_ca numeric; v_in numeric; v_over numeric;
  c numeric; r numeric; pf numeric; pr numeric; f numeric; f_reg numeric; f_acc numeric;
  v_leg numeric; v_fp numeric; v_l numeric; v_pc numeric; v_pr numeric; v_pp numeric; v_ppr numeric;
  d numeric; t numeric;
  v_inst uuid := gen_random_uuid(); v_grp uuid; v_key text; v_offset_cat text; v_legs jsonb; v_res jsonb;
  v_self_support boolean := false; v_pool_handled boolean := false; v_pr_legs jsonb := '[]'::jsonb;
BEGIN
  -- 'engine_paid' (2026-09-29): commission paid by credit_agent_rent_commission, which books it
  -- as marketing_expense (X1). The offset credits that same line so the cost is counted once.
  IF p_route NOT IN ('agent_collection','deposit_settlement','engine_paid') THEN
    RAISE EXCEPTION 'unknown route %', p_route;
  END IF;

  SELECT COALESCE(rent_amount,0), COALESCE(total_repayment,0), COALESCE(request_fee,0), COALESCE(access_fee,0)
    INTO v_rr, v_tt, v_rf, v_af
  FROM rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  -- Unknown Rent Plan: refuse. Never book the amount as Principal against nothing.
  IF NOT FOUND OR v_tt <= 0 THEN
    RAISE EXCEPTION 'rent plan % not found or has no priced total', p_rent_request_id;
  END IF;

  -- Cents are preserved (2 dp). Fee parts stay whole shillings; Principal takes the decimal.
  v_amt := ROUND(COALESCE(p_amount,0), 2);
  IF v_amt <= 0 THEN RETURN jsonb_build_object('status','no_op'); END IF;
  v_res := public._rent_fee_refuse_cancelled(p_rent_request_id, v_amt, p_source_table, p_source_id);
  IF v_res IS NOT NULL THEN RETURN v_res; END IF;

  -- A reversed collection is not standing cash: never split it (marker copied, nothing posted).
  IF p_source_table = 'agent_collections' AND EXISTS (
       SELECT 1 FROM agent_collections ac WHERE ac.id = p_source_id AND ac.reversed_at IS NOT NULL) THEN
    RETURN jsonb_build_object('status','source_reversed');
  END IF;

  IF EXISTS (SELECT 1 FROM instalment_allocations ia
              WHERE ia.rent_request_id=p_rent_request_id AND ia.source_table=p_source_table
                AND ia.source_id=p_source_id) THEN
    RETURN jsonb_build_object('status','already_allocated');
  END IF;

  -- Approved plan-level parts.
  v_comm_t := ROUND(0.10 * v_tt);
  v_part_t := LEAST(ROUND(0.15 * v_rr), v_tt - v_rr - v_comm_t);
  v_plat_t := v_tt - v_rr - v_comm_t - v_part_t;

  -- Standing cash already split on this plan (reversed rows excluded).
  -- Legacy-split rows count as cash at their formula share; four-part rows count
  -- at the parts actually booked, so any rounding carried earlier is caught up.
  SELECT COALESCE(SUM(ia.instalment_amount - COALESCE(ia.over_total_amount,0))
                    FILTER (WHERE COALESCE(ia.split_version,'') <> 'four_part_v1'),0),
         COALESCE(SUM(ia.instalment_amount - COALESCE(ia.over_total_amount,0))
                    FILTER (WHERE ia.split_version = 'four_part_v1'),0),
         COALESCE(SUM(ia.agent_commission_component) FILTER (WHERE ia.split_version = 'four_part_v1'),0),
         COALESCE(SUM(ia.partner_reward_component)   FILTER (WHERE ia.split_version = 'four_part_v1'),0),
         COALESCE(SUM(ia.platform_net_component)     FILTER (WHERE ia.split_version = 'four_part_v1'),0),
         COALESCE(SUM(ia.principal_component)        FILTER (WHERE ia.split_version = 'four_part_v1'),0)
    INTO v_leg, v_fp, v_pc, v_pr, v_pp, v_ppr
  FROM instalment_allocations ia
  WHERE ia.rent_request_id = p_rent_request_id AND ia.reversed_at IS NULL;

  v_l   := LEAST(v_leg, v_tt);
  v_pc  := v_pc + FLOOR(v_l * v_comm_t / v_tt);
  v_pr  := v_pr + FLOOR(v_l * v_part_t / v_tt);
  v_pp  := v_pp + FLOOR(v_l * v_plat_t / v_tt);
  v_ppr := v_ppr + v_l - FLOOR(v_l * v_comm_t / v_tt) - FLOOR(v_l * v_part_t / v_tt) - FLOOR(v_l * v_plat_t / v_tt);
  v_prior := v_leg + v_fp;

  v_cb := LEAST(v_prior, v_tt);
  v_ca := LEAST(v_prior + v_amt, v_tt);
  v_in := v_ca - v_cb;
  v_over := v_amt - v_in;

  -- Each fee part: its cumulative target at v_ca less what is already booked.
  c  := GREATEST(FLOOR(v_ca * v_comm_t / v_tt) - v_pc, 0);
  r  := GREATEST(FLOOR(v_ca * v_part_t / v_tt) - v_pr, 0);
  pf := GREATEST(FLOOR(v_ca * v_plat_t / v_tt) - v_pp, 0);
  pr := v_in - c - r - pf;

  -- Rounding: Principal absorbs a shortfall, taken from Platform Fee first,
  -- then Partner Returns, then Agent Commission. Never negative.
  IF pr < 0 THEN
    d := -pr;
    t := LEAST(d, pf); pf := pf - t; d := d - t;
    t := LEAST(d, r);  r  := r  - t; d := d - t;
    t := LEAST(d, c);  c  := c  - t; d := d - t;
    pr := 0;
  END IF;
  -- Principal never exceeds the rent across the plan; any excess returns to
  -- Platform Fee first, then Partner Returns, then Agent Commission (each up to its plan part).
  d := pr - (v_rr - v_ppr);
  IF d > 0 THEN
    pr := pr - d;
    t := LEAST(d, GREATEST(v_plat_t - v_pp - pf, 0)); pf := pf + t; d := d - t;
    t := LEAST(d, GREATEST(v_part_t - v_pr - r, 0));  r  := r  + t; d := d - t;
    t := LEAST(d, GREATEST(v_comm_t - v_pc - c, 0));  c  := c  + t; d := d - t;
    pr := pr + d;  -- only reachable if the plan parts are already exhausted
  END IF;
  -- Historical correction only: the agent route never passes p_commission_paid, so live
  -- collections are unaffected. When given, Agent Commission is booked at the amount
  -- ACTUALLY paid (to the cent) and Principal absorbs the rounding difference, so the
  -- offset equals the commission already credited and no extra commission is implied.
  IF p_route = 'agent_collection' AND p_commission_paid IS NOT NULL AND v_in > 0 THEN
    -- Guard: the commission already paid may differ from the split's share only by rounding.
    IF abs(p_commission_paid - c) > 1 THEN
      RAISE EXCEPTION 'commission paid % differs from commission share % by more than UGX 1', p_commission_paid, c;
    END IF;
    pr := pr + (c - p_commission_paid);
    c  := p_commission_paid;
  END IF;
  f  := c + r + pf;

  IF c < 0 OR r < 0 OR pf < 0 OR pr < 0 OR (pr + c + r + pf) <> v_in OR (v_in + v_over) <> v_amt THEN
    RAISE EXCEPTION 'four-part split failed to reconcile: P% C% R% F% in% over% amt%', pr, c, r, pf, v_in, v_over, v_amt;
  END IF;

  -- Fee part kept in the registration/access columns so L7 and the Treasury
  -- custody transfer read the same fee amount they always have.
  f_reg := CASE WHEN (v_rf + v_af) > 0 THEN FLOOR(f * v_rf / (v_rf + v_af)) ELSE 0 END;
  f_acc := f - f_reg;

  INSERT INTO instalment_allocations
    (rent_request_id, instalment_id, instalment_amount, principal_component,
     registration_fee_component, access_fee_component, partner_reward_component,
     agent_commission_component, platform_net_component, source_table, source_id,
     split_version, over_total_amount, commission_paid_component)
  VALUES (p_rent_request_id, v_inst, v_amt, pr, f_reg, f_acc, r, c, pf,
          p_source_table, p_source_id, 'four_part_v1', v_over,
          CASE WHEN p_route IN ('agent_collection','engine_paid') THEN 0 ELSE p_commission_paid END);

  IF v_over > 0 THEN
    INSERT INTO rent_fee_collection_exceptions
      (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
    VALUES (p_rent_request_id, p_source_id, p_source_table, v_amt, 'collection_above_plan_total',
      jsonb_build_object('amount_above_total', v_over, 'amount_within_total', v_in,
        'plan_total', v_tt, 'route', p_route,
        'note', 'Cash above the approved Rent Plan total. No fee split applied. Any commission paid on it is reported here only; nothing is reversed.'))
    ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
  END IF;

  -- Principal destination (accounting only): recovered Principal is reclassified from
  -- Cash in Transit (A5) to the Landlord Float Pool (A22 company-managed, A21 self-support).
  -- No A2 leg: the collection already took the whole repayment out of agent float.
  -- Skipped when the plan was funded from the pool, because trg_zz_landlord_pool_return
  -- posts the Principal return itself on that path (prevents a double A22 posting).
  SELECT (rr.self_funding_partner_id IS NOT NULL OR rr.self_funding_line_id IS NOT NULL)
    INTO v_self_support FROM rent_requests rr WHERE rr.id = p_rent_request_id;
  v_pool_handled := EXISTS (SELECT 1 FROM landlord_pool_movements m
                             WHERE m.rent_request_id = p_rent_request_id AND m.kind = 'deploy');
  IF pr > 0 AND NOT v_pool_handled THEN
    v_pr_legs := jsonb_build_array(
      jsonb_build_object(
        'direction','cash_in','amount', pr,
        'category', CASE WHEN v_self_support THEN 'landlord_pool_return_self_support'
                         ELSE 'landlord_pool_return_company_managed' END,
        'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
        'reference_id',v_inst::text,'currency','UGX','transaction_date',COALESCE(p_journal_date, now()),'classification','production',
        'description','Recovered Rent Plan Principal returned to Landlord Float Pool (accounting only; no landlord obligation, no wallet movement)'),
      jsonb_build_object(
        'direction','cash_out','amount', pr, 'category','landlord_pool_return_source',
        'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
        'reference_id',v_inst::text,'currency','UGX','transaction_date',COALESCE(p_journal_date, now()),'classification','production',
        'description','Recovered Rent Plan Principal moved out of Cash in Transit'));
  END IF;

  IF f > 0 OR jsonb_array_length(v_pr_legs) > 0 THEN
    v_offset_cat := CASE WHEN p_route = 'agent_collection' THEN 'agent_commission_payable'
                         WHEN p_route = 'engine_paid' THEN 'marketing_expense'
                         ELSE 'agent_commission_settled' END;
    v_key := COALESCE(p_idempotency_key, 'four-part-fee:' || p_source_table || ':' || p_source_id::text);
    v_legs := CASE WHEN f > 0 THEN jsonb_build_array(jsonb_build_object(
        'direction','cash_out','amount', f, 'category','treasury_fee_drawdown',
        'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
        'reference_id',v_inst::text,'currency','UGX','transaction_date',COALESCE(p_journal_date, now()),'classification','production',
        'description','Deferred fee drawn down on tenant rent collection (four-part waterfall)')) ELSE '[]'::jsonb END
      || CASE WHEN pf > 0 THEN jsonb_build_array(jsonb_build_object(
        'direction','cash_in','amount', pf, 'category','platform_fee_collected',
        'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
        'reference_id',v_inst::text,'currency','UGX','transaction_date',COALESCE(p_journal_date, now()),'classification','production',
        'description','Platform Fee (residual) on tenant rent collection')) ELSE '[]'::jsonb END
      || CASE WHEN r > 0 THEN jsonb_build_array(jsonb_build_object(
        'direction','cash_in','amount', r, 'category','partner_returns_allocated',
        'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
        'reference_id',v_inst::text,'currency','UGX','transaction_date',COALESCE(p_journal_date, now()),'classification','production',
        'description','Partner Returns share of collected fees (held in L7, not revenue; not owed or paid from here)')) ELSE '[]'::jsonb END
      || CASE WHEN c > 0 THEN jsonb_build_array(jsonb_build_object(
        'direction','cash_in','amount', c, 'category', v_offset_cat,
        'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
        'reference_id',v_inst::text,'currency','UGX','transaction_date',COALESCE(p_journal_date, now()),'classification','production',
        'description','Agent Commission funded from collected fees (offsets the commission already paid; no wallet movement)')) ELSE '[]'::jsonb END
      || v_pr_legs;

    SELECT public.create_ledger_transaction(entries := v_legs, idempotency_key := v_key) INTO v_grp;
    UPDATE instalment_allocations SET transaction_group_id = v_grp WHERE instalment_id = v_inst;
  END IF;

  RETURN jsonb_build_object('status','posted','split_version','four_part_v1',
    'instalment_id',v_inst,'transaction_group_id',v_grp,'payment_amount',v_amt,
    'principal',pr,'agent_commission_accounting',c,'partner_returns',r,'platform_fee',pf,
    'amount_above_total',v_over,'total_fees_collected',f,
    'registration_fee_collected',f_reg,'access_fee_collected',f_acc);
END $function$

;
