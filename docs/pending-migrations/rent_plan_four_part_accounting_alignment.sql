-- STATUS: DRAFT, NOT APPLIED. Awaiting approval. Do not apply without sign-off.
-- Rent Plan four-part waterfall: accounting-only alignment of the agent-collection and
-- deposit-settlement routes, cap at plan total, over-total exceptions, reversal accounting.
-- Tested on a throwaway local Postgres 16 with live function bodies; 2026-09-28.

-- ============================================================================
-- Rent Plan four-part waterfall: accounting-only alignment of both repayment
-- routes. NO wallet leg, commission wallet payment, repayment, funding or
-- Supporter payout is created or changed by anything in this file.
-- ============================================================================

-- 1. Additive columns on the split record (nothing dropped, nothing renamed).
ALTER TABLE public.instalment_allocations
  ADD COLUMN IF NOT EXISTS split_version text,
  ADD COLUMN IF NOT EXISTS over_total_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_paid_component numeric,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_group_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;
COMMENT ON COLUMN public.instalment_allocations.split_version IS
  'NULL = legacy proportional split; four_part_v1 = approved waterfall (Principal / 15% Partner Returns / 10% Agent Commission / Platform Fee).';
COMMENT ON COLUMN public.instalment_allocations.over_total_amount IS
  'Cash on this collection above the approved Rent Plan total. Receives no fee split; flagged in rent_fee_collection_exceptions.';
COMMENT ON COLUMN public.instalment_allocations.commission_paid_component IS
  'Commission actually paid to wallets for this row by its route (route B only). Accounting commission is agent_commission_component.';

-- 1b. Reversal marker backfill (classification only).
--     Copies the reversal status of the original agent collection onto its existing
--     split record so reversed cash is excluded from the standing-cash running total.
--     No journal entry, no wallet movement, no repayment or tenant balance change.
--     reversal_group_id stays NULL: no reversal posting is made for these rows.
UPDATE public.instalment_allocations ia
   SET reversed_at     = ac.reversed_at,
       reversal_reason = 'Marker copied from reversed agent collection at four-part migration (no posting)'
  FROM public.agent_collections ac
 WHERE ia.source_table = 'agent_collections'
   AND ia.source_id    = ac.id
   AND ac.reversed_at IS NOT NULL
   AND ia.reversed_at IS NULL;

-- 2. Two new accounting-only categories. platform_fee_collected is revenue (R1).
--    partner_returns_allocated is NOT revenue: it is held in L7 (Platform Treasury holding, the
--    same account the fee drawdown relieves), pending resolution of BD-2. It is not mapped to
--    the L3 Partner obligation account and triggers no Supporter Returns payment/cost logic.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
SELECT 'platform', v.c, NULL, v.a, 'cash_out', v.n
FROM (VALUES
  ('platform_fee_collected','R1','Four-part waterfall Platform Fee (residual). Post cash_in to CREDIT R1.'),
  ('partner_returns_allocated','L7','Four-part waterfall Partner Returns share of collected fees. Accounting allocation HELD in L7 (Platform Treasury holding). NOT revenue, NOT the L3 obligation (BD-2 unresolved), NOT a payment. Supporter Returns remain paid and expensed by the monthly returns engine. Post cash_in to CREDIT L7.')
) v(c, a, n)
WHERE NOT EXISTS (SELECT 1 FROM public.ledger_account_map m
                  WHERE m.ledger_scope='platform' AND m.category=v.c AND m.wallet_bucket IS NULL);

-- 3. Shared four-part split + posting core used by BOTH routes.
--    p_route = 'agent_collection'  : commission was paid via agent_commission_payable (X3)
--                                   -> offset credited back to X3.
--    p_route = 'deposit_settlement': commission is paid via agent_commission_settled (L5 debit)
--                                   -> offset credited to L5.
--    Split is cumulative over STANDING cash only (reversed rows excluded; balance
--    corrections never create rows) and capped at the approved Rent Plan total.
-- Journal date: NULL = now() (live routes, unchanged); the historical correction passes the
-- original collection date so each journal is dated when the cash was collected.
DROP FUNCTION IF EXISTS public._post_four_part_fee_split(uuid, numeric, text, uuid, text, numeric, text);
CREATE OR REPLACE FUNCTION public._post_four_part_fee_split(
  p_rent_request_id uuid, p_amount numeric, p_source_table text, p_source_id uuid,
  p_route text, p_commission_paid numeric DEFAULT NULL, p_idempotency_key text DEFAULT NULL,
  p_journal_date timestamptz DEFAULT NULL)
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
  v_inst uuid := gen_random_uuid(); v_grp uuid; v_key text; v_offset_cat text; v_legs jsonb;
BEGIN
  IF p_route NOT IN ('agent_collection','deposit_settlement') THEN
    RAISE EXCEPTION 'unknown route %', p_route;
  END IF;

  SELECT COALESCE(rent_amount,0), COALESCE(total_repayment,0), COALESCE(request_fee,0), COALESCE(access_fee,0)
    INTO v_rr, v_tt, v_rf, v_af
  FROM rent_requests WHERE id = p_rent_request_id FOR UPDATE;

  v_amt := ROUND(COALESCE(p_amount,0));
  IF v_amt <= 0 THEN RETURN jsonb_build_object('status','no_op'); END IF;

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
          CASE WHEN p_route = 'agent_collection' THEN 0 ELSE p_commission_paid END);

  IF v_over > 0 THEN
    INSERT INTO rent_fee_collection_exceptions
      (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
    VALUES (p_rent_request_id, p_source_id, p_source_table, v_amt, 'collection_above_plan_total',
      jsonb_build_object('amount_above_total', v_over, 'amount_within_total', v_in,
        'plan_total', v_tt, 'route', p_route,
        'note', 'Cash above the approved Rent Plan total. No fee split applied. Any commission paid on it is reported here only; nothing is reversed.'))
    ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
  END IF;

  IF f > 0 THEN
    v_offset_cat := CASE WHEN p_route = 'agent_collection' THEN 'agent_commission_payable'
                         ELSE 'agent_commission_settled' END;
    v_key := COALESCE(p_idempotency_key, 'four-part-fee:' || p_source_table || ':' || p_source_id::text);
    v_legs := jsonb_build_array(jsonb_build_object(
        'direction','cash_out','amount', f, 'category','treasury_fee_drawdown',
        'ledger_scope','platform','source_table',p_source_table,'source_id',p_source_id::text,
        'reference_id',v_inst::text,'currency','UGX','transaction_date',COALESCE(p_journal_date, now()),'classification','production',
        'description','Deferred fee drawn down on tenant rent collection (four-part waterfall)'))
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
        'description','Agent Commission funded from collected fees (offsets the commission already paid; no wallet movement)')) ELSE '[]'::jsonb END;

    SELECT public.create_ledger_transaction(entries := v_legs, idempotency_key := v_key) INTO v_grp;
    UPDATE instalment_allocations SET transaction_group_id = v_grp WHERE instalment_id = v_inst;
  END IF;

  RETURN jsonb_build_object('status','posted','split_version','four_part_v1',
    'instalment_id',v_inst,'transaction_group_id',v_grp,'payment_amount',v_amt,
    'principal',pr,'agent_commission_accounting',c,'partner_returns',r,'platform_fee',pf,
    'amount_above_total',v_over,'total_fees_collected',f,
    'registration_fee_collected',f_reg,'access_fee_collected',f_acc);
END $function$;
REVOKE ALL ON FUNCTION public._post_four_part_fee_split(uuid,numeric,text,uuid,text,numeric,text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_four_part_waterfall_eligible(p_rent_request_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT r.rent_amount > 0 AND r.total_repayment > r.rent_amount
                      AND (r.total_repayment - r.rent_amount) >= ROUND(0.10 * r.total_repayment)
                   FROM rent_requests r WHERE r.id = p_rent_request_id), false)
$$;

CREATE OR REPLACE FUNCTION public._post_rent_fee_collection_legacy(p_rent_request_id uuid, p_payment_amount numeric, p_source_table text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a record; v_inst uuid := gen_random_uuid(); v_grp uuid; v_fees numeric; v_key text; v_recog boolean;
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
  IF (COALESCE(a.principal_component,0)+COALESCE(a.registration_fee_component,0)
      +COALESCE(a.access_fee_component,0)) <= 0 THEN
    RETURN jsonb_build_object('status','no_allocation');
  END IF;
  v_fees := COALESCE(a.registration_fee_component,0) + COALESCE(a.access_fee_component,0);

  INSERT INTO instalment_allocations
    (rent_request_id, instalment_id, instalment_amount, principal_component,
     registration_fee_component, access_fee_component,
     partner_reward_component, agent_commission_component, platform_net_component,
     source_table, source_id)
  VALUES (p_rent_request_id, v_inst, ROUND(p_payment_amount),
          a.principal_component, a.registration_fee_component, a.access_fee_component,
          NULL, NULL, NULL, p_source_table, p_source_id);

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
    'access_fee_collected',a.access_fee_component,'total_fees_collected',v_fees);
END;
$function$

;
REVOKE ALL ON FUNCTION public._post_rent_fee_collection_legacy FROM PUBLIC, anon, authenticated;
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
  v_p numeric; v_d int; v_key text;
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
  IF (a.principal_component + a.registration_fee_component + a.access_fee_component) <= 0 THEN
    RETURN jsonb_build_object('status','no_allocation');
  END IF;

  SELECT COALESCE(SUM(ia.agent_commission_component),0), COALESCE(SUM(ia.partner_reward_component),0),
         COALESCE(SUM(ia.access_fee_component),0)
    INTO v_prior_agent, v_prior_partner, v_cum_access
  FROM instalment_allocations ia WHERE ia.rent_request_id = p_rent_request_id;

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
     agent_commission_component, platform_net_component, source_table, source_id)
  VALUES (p_rent_request_id, v_inst_id, ROUND(p_instalment_amount), a.principal_component,
          a.registration_fee_component, a.access_fee_component, v_partner, v_agent, v_net,
          p_source_table, p_source_id);

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
END $function$

;
REVOKE ALL ON FUNCTION public._post_instalment_waterfall_legacy FROM PUBLIC, anon, authenticated;

-- 4. Route A entry point (agent cash collection). Same signature and return keys.
CREATE OR REPLACE FUNCTION public.post_rent_fee_collection(p_rent_request_id uuid, p_payment_amount numeric, p_source_table text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_recog boolean;
BEGIN
  IF p_rent_request_id IS NULL OR COALESCE(p_payment_amount,0) <= 0 THEN
    RETURN jsonb_build_object('status','no_op');
  END IF;
  IF NOT public.is_treasury_waterfall_scope(p_rent_request_id) THEN
    RETURN jsonb_build_object('status','out_of_scope_legacy');
  END IF;
  -- The 89 approved exceptions (and any plan that cannot satisfy all four rules)
  -- stay on the legacy proportional path, byte-for-byte.
  IF NOT public.is_four_part_waterfall_eligible(p_rent_request_id) THEN
    RETURN public._post_rent_fee_collection_legacy(p_rent_request_id, p_payment_amount, p_source_table, p_source_id);
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

  RETURN public._post_four_part_fee_split(p_rent_request_id, p_payment_amount, p_source_table, p_source_id,
           'agent_collection', NULL, 'rent-fee-collection:' || p_source_table || ':' || p_source_id::text);
END;
$function$;

-- 5. Route B entry point (deposit settlement / record_rent_request_repayment_v2).
--    'agent_commission' in the result is what settle_tenant_rent_from_deposit PAYS to
--    wallets; it is computed with the exact pre-change formula so the payment is unchanged.
CREATE OR REPLACE FUNCTION public.post_instalment_waterfall(p_rent_request_id uuid, p_instalment_amount numeric, p_source_table text, p_source_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_all_prior numeric; v_prior_paid numeric; v_paid numeric; v_res jsonb;
BEGIN
  PERFORM 1 FROM rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'rent_request % not found', p_rent_request_id; END IF;

  IF NOT public.is_four_part_waterfall_eligible(p_rent_request_id) THEN
    RETURN public._post_instalment_waterfall_legacy(p_rent_request_id, p_instalment_amount, p_source_table, p_source_id, p_idempotency_key);
  END IF;

  IF EXISTS (SELECT 1 FROM instalment_allocations ia
             WHERE ia.rent_request_id=p_rent_request_id
               AND ia.source_table=p_source_table AND ia.source_id=p_source_id) THEN
    RETURN jsonb_build_object('status','already_allocated');
  END IF;
  IF ROUND(COALESCE(p_instalment_amount,0)) <= 0 THEN
    RETURN jsonb_build_object('status','no_allocation');
  END IF;

  -- Deposit-route commission PAYMENT = 10% of THIS deposit payment only.
  -- Prior agent-route collections (already paid 10% by agent_allocate_tenant_payment_internal)
  -- and reversed collections are deliberately NOT part of this calculation.
  -- (Pre-fix formula ROUND(10% x all split rows) - deposit-route commission paid
  --  re-paid 10% on earlier agent cash: UGX 42,200 on 9 plans to 2026-09-28.)
  v_all_prior := NULL; v_prior_paid := NULL;
  v_paid := ROUND(ROUND(p_instalment_amount) * 0.10);

  v_res := public._post_four_part_fee_split(p_rent_request_id, p_instalment_amount, p_source_table, p_source_id,
             'deposit_settlement', v_paid,
             COALESCE(p_idempotency_key, 'four-part-fee:' || p_source_table || ':' || p_source_id::text));

  IF v_res->>'status' <> 'posted' THEN RETURN v_res; END IF;

  RETURN v_res || jsonb_build_object(
    'agent_commission', v_paid,
    'partner_reward_allocation', (v_res->>'partner_returns')::numeric,
    'platform_net', (v_res->>'platform_fee')::numeric,
    'registration', (v_res->>'registration_fee_collected')::numeric,
    'access', (v_res->>'access_fee_collected')::numeric);
END $function$;

-- 6. Reversal of a collection's fee accounting (both reversal paths call this).
--    Mirrors the fee posting and the Treasury custody transfer, marks the split row
--    reversed. Touches no wallet leg and no commission payment/claw-back.
CREATE OR REPLACE FUNCTION public.reverse_rent_fee_allocation(p_collection_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ia record; v_legs jsonb; v_grp uuid; v_tgrp uuid;
BEGIN
  SELECT * INTO ia FROM instalment_allocations
   WHERE source_table='agent_collections' AND source_id=p_collection_id
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF ia.id IS NULL THEN RETURN jsonb_build_object('status','no_allocation'); END IF;
  IF ia.reversed_at IS NOT NULL THEN RETURN jsonb_build_object('status','already_reversed'); END IF;

  SELECT gl.transaction_group_id INTO v_tgrp FROM general_ledger gl
   WHERE gl.source_table='agent_collections' AND gl.source_id=p_collection_id
     AND gl.ledger_scope='platform' AND gl.category='cash_receipt_in_transit' AND gl.direction='cash_in'
   LIMIT 1;

  SELECT jsonb_agg(jsonb_build_object(
           'direction', CASE gl.direction WHEN 'cash_in' THEN 'cash_out' ELSE 'cash_in' END,
           'amount', gl.amount, 'category', gl.category, 'ledger_scope', gl.ledger_scope,
           'source_table', 'agent_collections', 'source_id', p_collection_id::text,
           'reference_id', 'FEEREV-' || left(p_collection_id::text,8), 'currency','UGX',
           'transaction_date', now(), 'classification', 'production',
           'description', left('Reversal of fee accounting for reversed collection: ' || COALESCE(p_reason,''), 300))
         ORDER BY gl.created_at, gl.id)
    INTO v_legs
  FROM general_ledger gl
  WHERE gl.ledger_scope = 'platform'
    AND ((ia.transaction_group_id IS NOT NULL AND gl.transaction_group_id = ia.transaction_group_id)
      OR (v_tgrp IS NOT NULL AND gl.transaction_group_id = v_tgrp
          AND gl.category IN ('agent_float_cash_offset','cash_receipt_in_transit')));

  IF v_legs IS NOT NULL AND jsonb_array_length(v_legs) > 0 THEN
    SELECT public.create_ledger_transaction(entries := v_legs,
             idempotency_key := 'rent-fee-reversal:agent_collections:' || p_collection_id::text) INTO v_grp;
  END IF;

  UPDATE instalment_allocations
     SET reversed_at = now(), reversal_group_id = v_grp, reversal_reason = p_reason
   WHERE id = ia.id;

  RETURN jsonb_build_object('status','reversed','allocation_id',ia.id,'reversal_group_id',v_grp,
    'legs_mirrored', COALESCE(jsonb_array_length(v_legs),0));
END $function$;
REVOKE ALL ON FUNCTION public.reverse_rent_fee_allocation(uuid,text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.agent_reverse_tenant_allocation(p_collection_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_collection record;
  v_txn_group uuid := gen_random_uuid();
  v_reversal_tracking text;
  v_commission numeric;
  v_rent_request record;
  v_fwd_float_dir text;
  v_rev_float_dir text;
  v_rev_disc_cat  text;
  v_rev_disc_dir  text;
  v_unreversed numeric;
  v_new_repaid numeric;
  v_new_status text;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (at least 5 characters)');
  END IF;

  SELECT * INTO v_collection
  FROM public.agent_collections
  WHERE id = p_collection_id;

  IF v_collection.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Allocation not found');
  END IF;

  IF v_collection.agent_id <> v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'You can only reverse your own allocations');
  END IF;

  IF COALESCE(v_collection.notes, '') NOT ILIKE '%float allocation%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only float allocations can be reversed');
  END IF;

  IF v_collection.reversed_at IS NOT NULL OR COALESCE(v_collection.notes, '') ILIKE '%[REVERSED%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'This allocation was already reversed');
  END IF;

  SELECT * INTO v_rent_request
  FROM public.rent_requests
  WHERE id = (
    SELECT source_id FROM public.general_ledger
    WHERE source_table = 'agent_collections'
      AND user_id = v_collection.agent_id
      AND category = 'agent_float_used_for_rent'
      AND description LIKE '%' || v_collection.tracking_id || '%'
    LIMIT 1
  );

  IF v_rent_request.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Original rent request not found');
  END IF;

  -- Mirror whichever shape the forward collection actually used.
  SELECT gl.direction INTO v_fwd_float_dir
    FROM public.general_ledger gl
   WHERE gl.source_table = 'agent_collections'
     AND gl.source_id = v_rent_request.id
     AND gl.user_id = v_collection.agent_id
     AND gl.category = 'agent_float_used_for_rent'
     AND gl.ledger_scope = 'wallet'
   ORDER BY gl.created_at DESC
   LIMIT 1;

  IF v_fwd_float_dir = 'cash_in' THEN
    v_rev_float_dir := 'cash_out';
    v_rev_disc_cat  := 'tenant_repayment_collected';
    v_rev_disc_dir  := 'cash_in';
  ELSE
    v_rev_float_dir := 'cash_in';
    v_rev_disc_cat  := 'tenant_repayment';
    v_rev_disc_dir  := 'cash_out';
  END IF;

  v_reversal_tracking := 'REV-' || v_collection.tracking_id;
  v_commission := ROUND(v_collection.amount * 0.10);

  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (v_collection.agent_id, v_collection.amount, v_rev_float_dir, 'agent_float_used_for_rent', 'agent_collections', v_rent_request.id,
    format('Reversal of float allocation — %s. Reason: %s', v_reversal_tracking, p_reason), 'wallet', v_txn_group);

  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (v_collection.agent_id, v_collection.amount, v_rev_disc_dir, v_rev_disc_cat, 'agent_collections', v_rent_request.id,
    format('Reversal of tenant repayment — %s', v_reversal_tracking), 'platform', v_txn_group);

  IF v_commission > 0 THEN
    INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
    VALUES (v_collection.agent_id, v_commission, 'cash_out', 'agent_commission_earned', 'agent_collections', v_rent_request.id,
      format('Commission reversal for allocation — %s', v_reversal_tracking), 'wallet', v_txn_group);

    INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
    VALUES (v_collection.agent_id, v_commission, 'cash_in', 'agent_commission_earned', 'agent_collections', v_rent_request.id,
      format('Reversed commission expense — %s', v_reversal_tracking), 'platform', v_txn_group);
  END IF;

  -- Mark the collection reversed FIRST so the recompute below excludes it.
  UPDATE public.agent_collections
  SET reversed_at = COALESCE(reversed_at, now()),
      notes = COALESCE(notes, '') || ' [REVERSED: ' || p_reason || ']'
  WHERE id = p_collection_id;

  -- Four-part waterfall: undo this collection's fee accounting (ledger-only; no wallet leg).
  BEGIN
    PERFORM public.reverse_rent_fee_allocation(p_collection_id, p_reason);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.rent_fee_collection_exceptions
        (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
      VALUES (v_collection.rent_request_id, p_collection_id, 'agent_collections', v_collection.amount,
              'fee_reversal_failed', jsonb_build_object('sqlerrm', left(SQLERRM, 400)))
      ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;


  -- Recompute the recorded total from the collections that survive, instead of
  -- blindly subtracting from a total that may have been capped at the plan
  -- ceiling (which produced phantom balances for overpaying tenants).
  SELECT COALESCE(SUM(c.amount), 0) INTO v_unreversed
  FROM public.agent_collections c
  WHERE c.rent_request_id = v_rent_request.id
    AND c.reversed_at IS NULL;

  -- Never drop below what the blind subtraction would have given: that protects
  -- repayments recorded through non-agent channels (tenant wallet, deposits).
  v_new_repaid := GREATEST(
    0,
    v_unreversed,
    COALESCE(v_rent_request.amount_repaid, 0) - v_collection.amount
  );
  v_new_repaid := LEAST(v_new_repaid, COALESCE(v_rent_request.total_repayment, v_new_repaid));

  IF v_new_repaid >= COALESCE(v_rent_request.total_repayment, 0) THEN
    v_new_status := 'completed';
  ELSIF v_rent_request.status = 'completed' THEN
    v_new_status := 'repaying';
  ELSE
    v_new_status := v_rent_request.status;
  END IF;

  UPDATE public.rent_requests
  SET amount_repaid = v_new_repaid,
      status = v_new_status,
      updated_at = NOW()
  WHERE id = v_rent_request.id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (v_collection.tenant_id, v_rent_request.id, -v_collection.amount, NOW());

  RETURN jsonb_build_object(
    'success', true,
    'reversal_tracking_id', v_reversal_tracking,
    'amount_returned', v_collection.amount,
    'commission_clawed_back', v_commission,
    'rent_request_id', v_rent_request.id,
    'recomputed_amount_repaid', v_new_repaid,
    'rent_request_status', v_new_status
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.admin_void_unverified_collection(p_collection_id uuid, p_actor_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_collection record;
  v_txn_group uuid := gen_random_uuid();
  v_leg record;
  v_new_direction text;
  v_leg_count int := 0;
  v_desc text;
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'actor_required');
  END IF;

  IF NOT (
    public.is_ops_role(p_actor_id)
    OR public.has_role(p_actor_id, 'manager')
    OR public.has_role(p_actor_id, 'cfo')
    OR public.has_role(p_actor_id, 'ceo')
    OR public.has_role(p_actor_id, 'coo')
    OR public.has_role(p_actor_id, 'cto')
    OR public.has_role(p_actor_id, 'super_admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_collection FROM public.agent_collections WHERE id = p_collection_id FOR UPDATE;

  IF v_collection.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'collection_not_found');
  END IF;

  IF v_collection.reversed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_reversed', 'collection_id', p_collection_id);
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  FOR v_leg IN
    SELECT * FROM public.general_ledger
    WHERE source_table = 'agent_collections'
      AND source_id = v_collection.rent_request_id
      AND created_at = v_collection.created_at
  LOOP
    v_new_direction := CASE v_leg.direction WHEN 'cash_in' THEN 'cash_out' WHEN 'cash_out' THEN 'cash_in' ELSE v_leg.direction END;
    v_desc := format(
      'VOID (no deposit/email evidence for this agent_float cash collection) — reversal of ledger leg %s. Reason: %s',
      v_leg.id, p_reason
    );

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id, description,
      ledger_scope, transaction_group_id, wallet_bucket, rent_request_id, idempotency_key,
      classification, solvency_bypass_reason
    ) VALUES (
      v_leg.user_id, v_leg.amount, v_new_direction, v_leg.category, 'agent_collections', v_collection.rent_request_id,
      v_desc,
      v_leg.ledger_scope, v_txn_group, v_leg.wallet_bucket, v_leg.rent_request_id,
      format('void_unverified_collection:%s:%s', v_collection.id, v_leg.id),
      'admin_correction', 'other_with_note'::public.solvency_bypass_reason
    );
    v_leg_count := v_leg_count + 1;
  END LOOP;

  IF v_leg_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_ledger_legs_found', 'collection_id', p_collection_id);
  END IF;

  UPDATE public.rent_requests
  SET amount_repaid = GREATEST(0, amount_repaid - v_collection.amount),
      status = CASE WHEN status = 'completed' THEN 'repaying' ELSE status END,
      updated_at = now()
  WHERE id = v_collection.rent_request_id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (v_collection.tenant_id, v_collection.rent_request_id, -v_collection.amount, now());

  UPDATE public.agent_collections
  SET reversed_at = now(),
      notes = COALESCE(notes, '') || format(' [VOID by %s: %s]', p_actor_id, p_reason)
  WHERE id = p_collection_id;

  -- Four-part waterfall: undo this collection's fee accounting (ledger-only; no wallet leg).
  BEGIN
    PERFORM public.reverse_rent_fee_allocation(p_collection_id, p_reason);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.rent_fee_collection_exceptions
        (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
      VALUES (v_collection.rent_request_id, p_collection_id, 'agent_collections', v_collection.amount,
              'fee_reversal_failed', jsonb_build_object('sqlerrm', left(SQLERRM, 400)))
      ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;


  RETURN jsonb_build_object(
    'success', true,
    'collection_id', p_collection_id,
    'amount_voided', v_collection.amount,
    'legs_reversed', v_leg_count,
    'transaction_group_id', v_txn_group
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist_base()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$ select array['🔧 Manual Adjustment', 'access_fee_collected', 'account_merge', 'advance_repayment', 'agent_advance_credit', 'agent_advance_repayment', 'agent_bonus', 'agent_commission', 'agent_commission_accrued', 'agent_commission_earned', 'agent_commission_payable', 'agent_commission_settled', 'agent_commission_used_for_rent', 'agent_commission_withdrawal', 'agent_facilitated_capital_receivable', 'agent_float_assignment', 'agent_float_cash_offset', 'agent_float_cycle_settled_to_bank', 'agent_float_deposit', 'agent_float_funding', 'agent_float_settlement', 'agent_float_topup', 'agent_float_used', 'agent_float_used_for_rent', 'agent_investment_commission', 'agent_landlord_payout', 'agent_proxy_investment', 'agent_repayment', 'angel_pool_investment', 'balance_correction', 'bucket_reclass_in', 'bucket_reclass_out', 'cash_at_bank_reclass', 'cash_custody_payable', 'cash_in_transit_banked', 'cash_receipt_in_transit', 'cfo_direct_credit', 'coo_proxy_investment', 'coo_proxy_investment_reversal', 'correction_reversal', 'credit_access_repayment', 'debt_clearance', 'debt_recovery', 'deposit', 'equipment_expense', 'facilitation_disbursement', 'fee_receivable_created', 'general_admin_expense', 'historical_balance_reseed', 'interest_expense', 'landlord_receivable_collected', 'landlord_receivable_created', 'landlord_receivable_obligation', 'landlord_rent_payment', 'listing_bonus', 'listing_bonus_expense', 'listing_rejection_offset', 'listing_rejection_penalty', 'listing_rejection_recovery', 'manager_credit', 'manager_debit', 'marketing_expense', 'merchant_float_correction_writedown', 'merchant_oop_reimbursement', 'orphan_reassignment', 'orphan_reversal', 'partner_capital_cash_received', 'partner_commission', 'partner_funding', 'partner_receivable_capital', 'partner_receivable_collected', 'partner_receivable_created', 'partner_reward_accrued', 'partner_returns_allocated', 'platform_fee_collected', 'payroll_expense', 'pending_portfolio_topup', 'platform_expense', 'platform_loss_writeoff', 'pool_capital_received', 'pool_rent_deployment_reversal', 'proxy_investment_commission', 'proxy_partner_withdrawal', 'reconciliation', 'referral_bonus', 'registration_fee_collected', 'rent_disbursement', 'rent_float_funding', 'rent_obligation', 'rent_obligation_reversal', 'rent_obligation_reversal_adjustment', 'rent_payment_for_tenant', 'rent_payment_received', 'rent_principal_collected', 'rent_receivable_created', 'rent_repayment', 'research_development_expense', 'roi_expense', 'roi_payout', 'roi_reinvestment', 'roi_wallet_credit', 'salary_advance', 'salary_advance_repayment', 'salary_payout', 'share_capital', 'staff_loan_disbursement', 'staff_loan_repayment', 'supporter_capital', 'supporter_rent_fund', 'system_balance_correction', 'tax_expense', 'tenant_default_charge', 'tenant_rent_settlement', 'tenant_repayment', 'tenant_repayment_collected', 'test_funds_cleanup', 'treasury_allocated', 'treasury_bank_deposit', 'treasury_fee_drawdown', 'treasury_fee_recognised', 'treasury_net_revenue', 'verified_bank_cash_recognised', 'wallet_deduction', 'wallet_deduction_cash_payout_retraction', 'wallet_deduction_general_adjustment', 'wallet_deposit', 'wallet_to_investment', 'wallet_transfer', 'wallet_withdrawal']::text[] $function$

;
CREATE OR REPLACE FUNCTION public.get_platform_cash_summary()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  result JSON;
  wallet_result JSON;
BEGIN
  -- Platform scope: revenue, costs, and recoveries
  SELECT json_build_object(
    'total_revenue', COALESCE(SUM(CASE 
      WHEN direction = 'cash_in' AND category IN (
        'tenant_access_fee','access_fee','tenant_request_fee','request_fee',
        'platform_service_income','landlord_platform_fee','management_fee',
        'access_fee_collected','registration_fee_collected','platform_fee_collected',
        'wallet_deduction'
      )
      THEN amount ELSE 0 END), 0),
    'total_costs', COALESCE(SUM(CASE 
      WHEN direction = 'cash_out' AND category IN (
        'supporter_platform_rewards','supporter_reward','investment_reward',
        'roi_payout','roi_expense',
        'agent_commission_payout','agent_commission','agent_payout',
        'agent_approval_bonus','referral_bonus','agent_commission_earned',
        'transaction_platform_expenses','operational_expenses','platform_expense',
        'system_balance_correction','wallet_deduction'
      )
      THEN amount ELSE 0 END), 0),
    'platform_cash_in', COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END), 0),
    'platform_cash_out', COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END), 0)
  ) INTO result
  FROM general_ledger
  WHERE ledger_scope = 'platform' 
    AND classification IN ('production','legacy_real')
    AND category != 'opening_balance';
    
  -- Wallet/bridge scope totals
  SELECT json_build_object(
    'wallet_cash_in', COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END), 0),
    'wallet_cash_out', COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END), 0)
  ) INTO wallet_result
  FROM general_ledger
  WHERE ledger_scope IN ('wallet','bridge')
    AND classification IN ('production','legacy_real');

  RETURN json_build_object(
    'total_revenue', (result->>'total_revenue')::numeric,
    'total_costs', (result->>'total_costs')::numeric,
    'platform_cash_in', (result->>'platform_cash_in')::numeric,
    'platform_cash_out', (result->>'platform_cash_out')::numeric,
    'wallet_cash_in', (wallet_result->>'wallet_cash_in')::numeric,
    'wallet_cash_out', (wallet_result->>'wallet_cash_out')::numeric
  );
END;
$function$

;
CREATE OR REPLACE FUNCTION public.get_cashflow_forecast_series(p_start timestamp with time zone, p_end timestamp with time zone, p_bucket text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_unit text;
  v_buckets jsonb := '[]'::jsonb;
  v_cats jsonb := '[]'::jsonb;
  v_partners jsonb := '[]'::jsonb;
  v_tz text := 'Africa/Kampala';
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view cashflow forecasts';
  END IF;

  v_unit := CASE lower(coalesce(p_bucket,'day'))
              WHEN 'week' THEN 'week'
              WHEN 'month' THEN 'month'
              ELSE 'day'
            END;

  WITH b AS (
    SELECT generate_series(
      date_trunc(v_unit, p_start AT TIME ZONE v_tz),
      date_trunc(v_unit, (p_end - interval '1 second') AT TIME ZONE v_tz),
      ('1 ' || v_unit)::interval
    ) AS bstart
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'key', to_char(bstart, 'YYYY-MM-DD'),
           'label', CASE v_unit
                      WHEN 'month' THEN to_char(bstart, 'Mon YYYY')
                      WHEN 'week' THEN 'Wk ' || to_char(bstart, 'DD Mon')
                      ELSE to_char(bstart, 'DD Mon')
                    END
         ) ORDER BY bstart), '[]'::jsonb)
    INTO v_buckets
  FROM b;

  WITH occ AS (
    SELECT pf.id, pf.investor_id,
           (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
           ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount,
           pf.maturity_date
    FROM _cf_partner_ops_portfolios() pf CROSS JOIN generate_series(0, 36) AS n
    WHERE pf.anchor_date IS NOT NULL
  ), f AS (
    SELECT date_trunc(v_unit, due_date::timestamp) AS bstart, amount
    FROM occ
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND (maturity_date IS NULL OR due_date <= maturity_date)
  ), fa AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM f GROUP BY bstart
  )
  SELECT jsonb_build_array(jsonb_build_object(
           'key', 'roi_forecast',
           'label', 'Forecasted Returns (Partner Ops portfolios)',
           'kind', 'forecast',
           'flow', 'out',
           'total', COALESCE((SELECT SUM(amount) FROM fa), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM fa), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM fa
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  WITH pf AS (
    SELECT * FROM _cf_partner_ops_portfolios()
  ), occ AS (
    SELECT pf.id, pf.investor_id,
           (pf.anchor_date + (n || ' month')::interval)::date AS due_date,
           ROUND(pf.investment_amount * pf.roi_percentage / 100.0) AS amount,
           pf.maturity_date
    FROM pf CROSS JOIN generate_series(0, 36) AS n
    WHERE pf.anchor_date IS NOT NULL
  ), w AS (
    SELECT * FROM occ
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND (maturity_date IS NULL OR due_date <= maturity_date)
  ), byp AS (
    SELECT w.investor_id,
           SUM(w.amount) AS projected,
           COUNT(*) AS payouts,
           MIN(w.due_date) AS next_due,
           COUNT(DISTINCT w.id) AS portfolios
    FROM w GROUP BY w.investor_id
  ), committed AS (
    SELECT investor_id, SUM(investment_amount) AS committed FROM pf GROUP BY investor_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'partner_id', byp.investor_id,
           'partner_name', COALESCE(pr.full_name, 'Partner'),
           'phone', pr.phone,
           'portfolios', byp.portfolios,
           'committed', COALESCE(c.committed, 0),
           'payouts', byp.payouts,
           'next_due', byp.next_due,
           'projected', byp.projected
         ) ORDER BY byp.projected DESC), '[]'::jsonb)
    INTO v_partners
  FROM byp
  LEFT JOIN committed c ON c.investor_id = byp.investor_id
  LEFT JOIN profiles pr ON pr.id = byp.investor_id;

  WITH w AS (
    SELECT date_trunc(v_unit, wr.created_at AT TIME ZONE v_tz) AS bstart, wr.amount
    FROM withdrawal_requests wr
    WHERE wr.status NOT IN ('completed','rejected','cancelled','failed')
      AND wr.created_at >= p_start AND wr.created_at < p_end
  ), wa AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM w GROUP BY bstart
  )
  SELECT v_cats || jsonb_build_array(jsonb_build_object(
           'key', 'withdrawals_queued',
           'label', 'Queued withdrawals (pipeline)',
           'kind', 'forecast',
           'flow', 'out',
           'total', COALESCE((SELECT SUM(amount) FROM wa), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM wa), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM wa
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  WITH rr AS (
    SELECT r.id,
           GREATEST(COALESCE(r.daily_repayment, 0), 0) AS daily,
           GREATEST(COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0), 0) AS remaining
    FROM rent_requests r
    WHERE r.status IN ('funded','repaying','active','disbursed')
      AND COALESCE(r.tenancy_status, 'active') <> 'ended'
      AND COALESCE(r.agent_payment_status, 'paying') <> 'not_paying'
      AND COALESCE(r.daily_repayment, 0) > 0
      AND COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0) > 0
  ), sched AS (
    SELECT rr.id,
           ((now() AT TIME ZONE v_tz)::date + n) AS due_date,
           LEAST(rr.daily, rr.remaining - (rr.daily * n)) AS amount
    FROM rr
    CROSS JOIN generate_series(0, 400) AS n
    WHERE (rr.daily * n) < rr.remaining
  ), w AS (
    SELECT date_trunc(v_unit, due_date::timestamp) AS bstart, amount
    FROM sched
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND amount > 0
  ), ra AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM w GROUP BY bstart
  )
  SELECT v_cats || jsonb_build_array(jsonb_build_object(
           'key', 'rent_receivables_forecast',
           'label', 'Expected tenant repayments (receivables)',
           'kind', 'forecast',
           'flow', 'in',
           'total', COALESCE((SELECT SUM(amount) FROM ra), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM ra), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM ra
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  WITH ad AS (
    SELECT a.id,
           GREATEST(COALESCE(NULLIF(a.daily_installment, 0), a.installment_amount, 0), 0) AS daily,
           GREATEST(COALESCE(a.outstanding_balance, 0), 0) AS remaining
    FROM agent_advances a
    WHERE a.status IN ('active','disbursed','repaying')
      AND COALESCE(a.deduction_paused, false) = false
      AND COALESCE(a.outstanding_balance, 0) > 0
      AND COALESCE(NULLIF(a.daily_installment, 0), a.installment_amount, 0) > 0
  ), sched AS (
    SELECT ad.id,
           ((now() AT TIME ZONE v_tz)::date + n) AS due_date,
           LEAST(ad.daily, ad.remaining - (ad.daily * n)) AS amount
    FROM ad CROSS JOIN generate_series(0, 400) AS n
    WHERE (ad.daily * n) < ad.remaining
  ), w AS (
    SELECT date_trunc(v_unit, due_date::timestamp) AS bstart, amount
    FROM sched
    WHERE due_date >= (p_start AT TIME ZONE v_tz)::date
      AND due_date <  (p_end AT TIME ZONE v_tz)::date
      AND amount > 0
  ), aa AS (
    SELECT bstart, SUM(amount) AS amount, COUNT(*) AS cnt FROM w GROUP BY bstart
  )
  SELECT v_cats || jsonb_build_array(jsonb_build_object(
           'key', 'advance_recovery_forecast',
           'label', 'Expected agent advance recoveries',
           'kind', 'forecast',
           'flow', 'in',
           'total', COALESCE((SELECT SUM(amount) FROM aa), 0),
           'count', COALESCE((SELECT SUM(cnt) FROM aa), 0),
           'points', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', to_char(bstart, 'YYYY-MM-DD'),
                      'amount', amount,
                      'count', cnt
                    ) ORDER BY bstart)
             FROM aa
           ), '[]'::jsonb)
         ))
    INTO v_cats;

  WITH src AS (
    SELECT gl.category,
           date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz) AS bstart,
           gl.amount
    FROM general_ledger gl
    WHERE gl.direction = 'cash_out'
      AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
      AND gl.classification <> 'admin_correction'
      AND gl.category IN (
        'roi_expense','wallet_withdrawal','rent_disbursement','agent_commission_earned',
        'agent_commission','payroll_expense','general_admin_expense','marketing_expense',
        'agent_float_deposit','agent_landlord_payout','rent_payment_for_tenant',
        'research_development_expense','agent_advance_credit','partner_funding'
      )
  ), agg AS (
    SELECT category, bstart, SUM(amount) AS amount, COUNT(*) AS cnt
    FROM src GROUP BY category, bstart
  )
  SELECT v_cats || COALESCE(jsonb_agg(c ORDER BY (c->>'total')::numeric DESC), '[]'::jsonb)
    INTO v_cats
  FROM (
    SELECT jsonb_build_object(
             'key', category,
             'label', initcap(replace(category, '_', ' ')),
             'kind', 'actual',
             'flow', 'out',
             'total', SUM(amount),
             'count', SUM(cnt),
             'points', jsonb_agg(jsonb_build_object(
                         'key', to_char(bstart, 'YYYY-MM-DD'),
                         'amount', amount,
                         'count', cnt
                       ) ORDER BY bstart)
           ) AS c
    FROM agg GROUP BY category
  ) x;

  WITH src AS (
    SELECT gl.category,
           date_trunc(v_unit, gl.transaction_date AT TIME ZONE v_tz) AS bstart,
           gl.amount
    FROM general_ledger gl
    WHERE gl.direction = 'cash_in'
      AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
      AND gl.classification <> 'admin_correction'
      AND gl.category <> 'system_balance_correction'
      AND gl.category IN (
        'tenant_repayment','tenant_repayment_collected','rent_principal_collected','agent_repayment','partner_funding',
        'wallet_deposit','share_capital','access_fee_collected','registration_fee_collected','platform_fee_collected',
        'debt_recovery','platform_service_income','tenant_default_charge','roi_reinvestment'
      )
  ), agg AS (
    SELECT category, bstart, SUM(amount) AS amount, COUNT(*) AS cnt
    FROM src GROUP BY category, bstart
  )
  SELECT v_cats || COALESCE(jsonb_agg(c ORDER BY (c->>'total')::numeric DESC), '[]'::jsonb)
    INTO v_cats
  FROM (
    SELECT jsonb_build_object(
             'key', 'in_' || category,
             'label', initcap(replace(category, '_', ' ')),
             'kind', 'actual',
             'flow', 'in',
             'total', SUM(amount),
             'count', SUM(cnt),
             'points', jsonb_agg(jsonb_build_object(
                         'key', to_char(bstart, 'YYYY-MM-DD'),
                         'amount', amount,
                         'count', cnt
                       ) ORDER BY bstart)
           ) AS c
    FROM agg GROUP BY category
  ) y;

  RETURN jsonb_build_object(
    'bucket', v_unit,
    'start', p_start,
    'end', p_end,
    'buckets', v_buckets,
    'categories', v_cats,
    'partners', v_partners,
    'portfolio_count', (SELECT COUNT(*) FROM _cf_partner_ops_portfolios()),
    'committed_capital', COALESCE((SELECT SUM(investment_amount) FROM _cf_partner_ops_portfolios()), 0)
  );
END;
$function$

;
CREATE OR REPLACE FUNCTION public.reconcile_rent_fee_l7()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH billed AS (
    SELECT gl.source_id AS rr, SUM(gl.amount) AS billed FROM general_ledger gl
    WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
      AND gl.source_table='rent_requests' GROUP BY 1
  ), collected AS (
    SELECT ia.rent_request_id AS rr, SUM(ia.registration_fee_component+ia.access_fee_component) AS collected
    FROM instalment_allocations ia WHERE ia.reversed_at IS NULL GROUP BY 1
  ), rent_groups AS (
    SELECT DISTINCT transaction_group_id AS g FROM instalment_allocations WHERE transaction_group_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'check_3_l7_per_plan', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
       'rent_request_id',b.rr,'fees_billed',b.billed,'fees_collected',COALESCE(c.collected,0),
       'l7_outstanding',b.billed-COALESCE(c.collected,0))),'[]'::jsonb)
       FROM billed b LEFT JOIN collected c ON c.rr=b.rr WHERE COALESCE(c.collected,0)>0),
    'l7_total_billed',(SELECT COALESCE(SUM(billed),0) FROM billed),
    'l7_total_collected',(SELECT COALESCE(SUM(collected),0) FROM collected),
    'check_7_non_rent_excluded', jsonb_build_object(
      'non_rent_r1_fee_activity',(SELECT COALESCE(SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount ELSE -gl.amount END),0)
        FROM general_ledger gl WHERE gl.category IN ('registration_fee_collected','access_fee_collected','platform_fee_collected')
          AND gl.ledger_scope='platform'
          AND NOT EXISTS (SELECT 1 FROM rent_groups rg WHERE rg.g=gl.transaction_group_id)),
      'note','Exists in R1 but deliberately excluded from every Landlord/Rent figure.'));
$function$

;
CREATE OR REPLACE FUNCTION public.reconcile_rent_fee_collections()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH grp AS (
    SELECT DISTINCT transaction_group_id AS g FROM instalment_allocations
     WHERE transaction_group_id IS NOT NULL AND split_version IS NULL
  ), r1 AS (
    SELECT gl.category, SUM(gl.amount) AS amt FROM general_ledger gl JOIN grp ON grp.g=gl.transaction_group_id
    WHERE gl.category IN ('registration_fee_collected','access_fee_collected') AND gl.direction='cash_in' GROUP BY 1
  ), alloc AS (
    SELECT COALESCE(SUM(registration_fee_component) FILTER (WHERE split_version IS NULL),0) AS reg,
           COALESCE(SUM(access_fee_component) FILTER (WHERE split_version IS NULL),0) AS acc, COUNT(*) AS n,
           COUNT(*) FILTER (WHERE ROUND(principal_component+registration_fee_component
                                        +access_fee_component+COALESCE(over_total_amount,0)) <> ROUND(instalment_amount)) AS mism
    FROM instalment_allocations
  ), fp AS (
    SELECT COALESCE(SUM(ia.registration_fee_component+ia.access_fee_component),0) AS fees,
           COALESCE(SUM(ia.agent_commission_component+ia.partner_reward_component+ia.platform_net_component),0) AS parts,
           COUNT(*) AS n
      FROM instalment_allocations ia WHERE ia.split_version = 'four_part_v1'
  ), fpl AS (
    SELECT COALESCE(SUM(gl.amount),0) AS legs
      FROM general_ledger gl
     WHERE gl.direction='cash_in' AND gl.ledger_scope='platform'
       AND gl.category IN ('platform_fee_collected','partner_returns_allocated','agent_commission_payable','agent_commission_settled')
       AND gl.transaction_group_id IN (SELECT transaction_group_id FROM instalment_allocations
                                        WHERE split_version='four_part_v1' AND transaction_group_id IS NOT NULL)
  ), bal AS (
    SELECT count(*) AS unbal FROM (
      SELECT gl.transaction_group_id
      FROM general_ledger gl
      JOIN (SELECT DISTINCT transaction_group_id AS g FROM instalment_allocations WHERE transaction_group_id IS NOT NULL) a
        ON a.g=gl.transaction_group_id
      LEFT JOIN ledger_account_map m ON m.ledger_scope=gl.ledger_scope AND m.category=gl.category AND m.wallet_bucket IS NULL
      GROUP BY 1
      HAVING abs(SUM(CASE WHEN gl.direction=COALESCE(m.debit_when,'cash_in') THEN gl.amount ELSE -gl.amount END))>0.5) x
  ), dupes AS (
    SELECT count(*) AS d FROM (SELECT rent_request_id,source_table,source_id FROM instalment_allocations
      GROUP BY 1,2,3 HAVING count(*)>1) y
  )
  SELECT jsonb_build_object(
    'check_1_registration', jsonb_build_object('scope','legacy split rows','allocations',(SELECT reg FROM alloc),
      'r1_legs',COALESCE((SELECT amt FROM r1 WHERE category='registration_fee_collected'),0),
      'pass',(SELECT reg FROM alloc)=COALESCE((SELECT amt FROM r1 WHERE category='registration_fee_collected'),0)),
    'check_2_access', jsonb_build_object('scope','legacy split rows','allocations',(SELECT acc FROM alloc),
      'r1_legs',COALESCE((SELECT amt FROM r1 WHERE category='access_fee_collected'),0),
      'pass',(SELECT acc FROM alloc)=COALESCE((SELECT amt FROM r1 WHERE category='access_fee_collected'),0)),
    'check_4_components_equal_payment', jsonb_build_object('mismatches',(SELECT mism FROM alloc),
      'pass',(SELECT mism FROM alloc)=0),
    'check_5_fee_groups_balance', jsonb_build_object('unbalanced',(SELECT unbal FROM bal),
      'pass',(SELECT unbal FROM bal)=0),
    'check_6_no_duplicate_allocations', jsonb_build_object('duplicates',(SELECT d FROM dupes),
      'pass',(SELECT d FROM dupes)=0),
    'check_8_four_part_fees_equal_parts', jsonb_build_object('rows',(SELECT n FROM fp),
      'fees',(SELECT fees FROM fp),'parts',(SELECT parts FROM fp),'ledger_lines',(SELECT legs FROM fpl),
      'pass',(SELECT fees FROM fp)=(SELECT parts FROM fp) AND (SELECT parts FROM fp)=(SELECT legs FROM fpl)),
    'allocations_total',(SELECT n FROM alloc),
    'open_exceptions',(SELECT count(*) FROM rent_fee_collection_exceptions WHERE resolved_at IS NULL));
$function$;

-- 7. Read-only exceptions report: standing cash above each plan's approved total,
--    with the commission already paid on that excess. Report only; nothing reversed.
CREATE OR REPLACE FUNCTION public.rent_fee_over_total_exceptions()
RETURNS TABLE(rent_request_id uuid, tenant_id uuid, plan_total numeric, standing_cash numeric,
              amount_above_total numeric, collections_above_total bigint,
              commission_paid_on_excess numeric, first_excess_at timestamptz, last_excess_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cfo','ceo','super_admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH a AS (
    SELECT ac.id, ac.rent_request_id, ac.tenant_id, ac.amount, ac.created_at, r.total_repayment AS tt,
           SUM(ac.amount) OVER (PARTITION BY ac.rent_request_id ORDER BY ac.created_at, ac.id) AS cum
      FROM agent_collections ac JOIN rent_requests r ON r.id = ac.rent_request_id
     WHERE ac.reversed_at IS NULL AND public.is_treasury_waterfall_scope(r.id)
  ), x AS (
    SELECT a.*, LEAST(a.amount, GREATEST(a.cum - a.tt, 0)) AS excess FROM a
  ), paid AS (
    SELECT x.id, COALESCE((SELECT SUM(g.amount) FROM general_ledger g
        WHERE g.ledger_scope='platform' AND g.direction='cash_out'
          AND g.category IN ('agent_commission_payable','agent_commission_settled')
          AND ((g.source_table='agent_collections' AND g.source_id = x.rent_request_id AND g.created_at = x.created_at)
            OR (g.source_table='agent_collections' AND g.source_id = x.id))),0) AS comm
      FROM x WHERE x.excess > 0
  )
  SELECT x.rent_request_id, max(x.tenant_id::text)::uuid, max(x.tt), max(x.cum), SUM(x.excess),
         COUNT(*) FILTER (WHERE x.excess > 0),
         ROUND(SUM(CASE WHEN x.excess > 0 THEN p.comm * x.excess / x.amount ELSE 0 END), 2),
         MIN(x.created_at) FILTER (WHERE x.excess > 0), MAX(x.created_at) FILTER (WHERE x.excess > 0)
    FROM x LEFT JOIN paid p ON p.id = x.id
   GROUP BY x.rent_request_id
  HAVING SUM(x.excess) > 0;
END $function$;
REVOKE ALL ON FUNCTION public.rent_fee_over_total_exceptions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_fee_over_total_exceptions() TO authenticated;

-- 8. Read-only exceptions report: deposit-route commission paid twice on earlier
--    agent-route cash under the pre-fix formula (UGX 42,200 on 9 plans at 2026-09-28).
--    Report only, for CFO decision. Nothing is recovered or reversed.
CREATE OR REPLACE FUNCTION public.rent_fee_deposit_commission_duplicates()
RETURNS TABLE(rent_request_id uuid, agent_route_cash numeric, deposit_route_cash numeric,
              deposit_commission_paid numeric, ten_percent_of_deposits numeric, commission_paid_twice numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cfo','ceo','super_admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT ia.rent_request_id,
         COALESCE(SUM(ia.instalment_amount) FILTER (WHERE ia.agent_commission_component IS NULL AND ia.split_version IS NULL),0),
         SUM(ia.instalment_amount) FILTER (WHERE ia.agent_commission_component IS NOT NULL AND ia.split_version IS NULL),
         SUM(ia.agent_commission_component) FILTER (WHERE ia.split_version IS NULL),
         SUM(ROUND(ia.instalment_amount * 0.10)) FILTER (WHERE ia.agent_commission_component IS NOT NULL AND ia.split_version IS NULL),
         SUM(ia.agent_commission_component - ROUND(ia.instalment_amount * 0.10))
           FILTER (WHERE ia.agent_commission_component IS NOT NULL AND ia.split_version IS NULL)
    FROM instalment_allocations ia
   GROUP BY ia.rent_request_id
  HAVING COALESCE(SUM(ia.agent_commission_component - ROUND(ia.instalment_amount * 0.10))
           FILTER (WHERE ia.agent_commission_component IS NOT NULL AND ia.split_version IS NULL),0) > 0;
END $function$;
REVOKE ALL ON FUNCTION public.rent_fee_deposit_commission_duplicates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_fee_deposit_commission_duplicates() TO authenticated;

-- 9. Historical correction of older agent collections that were never split.
--    NOT executed by this migration. Callable only by CFO/CEO/super_admin after CFO sign-off.
--    Platform-books journal only: no wallet entry, no commission payment, no change to
--    repayments, tenant balances, agent float or collection records.
--    Commission is booked at the amount actually paid (agent_commission_payable leg of the
--    original collection); Principal absorbs the sub-shilling rounding difference.
--    EXCLUDED pending separate treatment (2026-09-28 instruction):
--      * plan 39976d4a (over-repaid / exception status under separate reconciliation)
--      * plan 7a02c339 (cancelled; UGX 55,000 collected; pending CFO treatment)
--    Reported by plan-id prefix, enforced below by prefix match.
CREATE OR REPLACE FUNCTION public.rent_fee_correct_unsplit_agent_collections(p_dry_run boolean DEFAULT true)
RETURNS TABLE(collection_id uuid, rent_request_id uuid, amount numeric, commission_paid numeric,
              principal numeric, partner_returns numeric, agent_commission numeric,
              platform_fee numeric, total_allocated numeric, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE c record; v_paid numeric; v_n int; v_res jsonb;
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cfo','ceo','super_admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  FOR c IN
    SELECT ac.id, ac.rent_request_id AS rr, ac.amount, ac.created_at, ac.agent_id
      FROM agent_collections ac
     WHERE ac.reversed_at IS NULL AND ac.amount > 0
       AND ac.created_at >= '2026-09-08' AND ac.created_at < '2026-09-10'
       AND NOT EXISTS (SELECT 1 FROM instalment_allocations ia
                        WHERE ia.source_table='agent_collections' AND ia.source_id = ac.id)
       AND left(ac.rent_request_id::text, 8) NOT IN ('39976d4a','7a02c339')
       AND public.is_treasury_waterfall_scope(ac.rent_request_id)   -- 16 in scope; 276 pre-go-live excluded
       AND public.is_four_part_waterfall_eligible(ac.rent_request_id)
     ORDER BY ac.created_at, ac.id
  LOOP
    -- Commission actually paid: the original collection's platform payable leg.
    -- Ledger links it by plan id (source_id = rent_request_id, uuid) at the collection instant.
    SELECT COALESCE(SUM(g.amount),0), count(*) INTO v_paid, v_n
      FROM general_ledger g
     WHERE g.category='agent_commission_payable' AND g.direction='cash_out'
       AND g.source_table='agent_collections' AND g.source_id = c.rr
       AND abs(extract(epoch FROM g.created_at - c.created_at)) < 10;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'collection %: expected exactly 1 commission leg, found %', c.id, v_n;
    END IF;
    IF p_dry_run THEN
      collection_id := c.id; rent_request_id := c.rr; amount := c.amount; commission_paid := v_paid;
      status := 'dry_run'; RETURN NEXT; CONTINUE;
    END IF;
    v_res := public._post_four_part_fee_split(c.rr, c.amount, 'agent_collections', c.id,
               'agent_collection', v_paid, 'four-part-fee:agent_collections:' || c.id::text,
               c.created_at);
    collection_id := c.id; rent_request_id := c.rr; amount := c.amount; commission_paid := v_paid;
    principal := (v_res->>'principal')::numeric; partner_returns := (v_res->>'partner_returns')::numeric;
    agent_commission := (v_res->>'agent_commission_accounting')::numeric;
    platform_fee := (v_res->>'platform_fee')::numeric;
    total_allocated := principal + partner_returns + agent_commission + platform_fee;
    status := v_res->>'status'; RETURN NEXT;
  END LOOP;
END $function$;
REVOKE ALL ON FUNCTION public.rent_fee_correct_unsplit_agent_collections(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_fee_correct_unsplit_agent_collections(boolean) TO authenticated;
