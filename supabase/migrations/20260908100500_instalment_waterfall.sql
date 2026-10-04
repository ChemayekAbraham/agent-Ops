-- PHASE 2: Landlord Flow instalment waterfall.
--
-- COMPONENT MODEL (cumulative true-up, so a full schedule reconciles exactly)
--   principal / registration / access   <- allocate_instalment()  (Phase 1)
--   agent_commission = 10% of instalment            (Model A rule, unchanged)
--   partner_reward   = plan partner total pro-rata to the access component
--   platform_net     = access - agent - partner
--
-- BD-2 (allocate-only): the partner reward posts NO ledger leg and creates NO L3
-- payable. It is recorded in instalment_allocations.partner_reward_component for
-- economic attribution only; the portfolio-level ROI mechanism remains the sole
-- partner obligation.
--
-- GL LEGS (Treasury allocation only - cash/A3 legs stay with the caller):
--   DR L7 treasury_allocated       = access + registration
--   CR L5 agent_commission_accrued = agent commission   (traceable, not X1)
--   R1 treasury_net_revenue        = (access + registration) - agent
--        cash_out => CREDIT R1 when positive
--        cash_in  => DEBIT  R1 when negative (contra-revenue subsidy; this is
--                    how BD-3 economics arise prospectively on legacy plans
--                    priced below the BD-4 floor)
--
-- So R1 = platform_net + partner_reward + registration. The partner reward is
-- borne through the portfolio ROI expense (X2), so within the Landlord Flow it
-- is an attribution against revenue rather than a separate charge.
--
-- LEDGER CONTROL NOTE: platform.treasury_net_revenue is mapped debit_when
-- 'cash_in'. The inherited R1 convention (debit_when 'cash_out', as on
-- registration_fee_collected) was tried first and REJECTED: it made the revenue
-- credit share a raw direction with the L7 debit, so the group passed the mapped
-- control but FAILED the raw-direction control inside create_ledger_transaction
-- ("Total cash_in (18834) <> total cash_out (4500)"). The chosen convention
-- satisfies BOTH controls. Existing R1 categories keep their own convention.

UPDATE public.ledger_account_map SET debit_when = 'cash_in',
  notes = 'Platform Net portion of Treasury. Post cash_out to CREDIT R1 (revenue); post cash_in to DEBIT R1 (contra-revenue pricing subsidy). Convention chosen so Treasury groups satisfy both the raw-direction and mapped DR/CR controls.'
WHERE ledger_scope = 'platform' AND category = 'treasury_net_revenue';

CREATE OR REPLACE FUNCTION public.post_instalment_waterfall(
  p_rent_request_id uuid,
  p_instalment_amount numeric,
  p_source_table text,
  p_source_id uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
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

  -- Idempotency / retry safety: one allocation per (request, source_table, source_id).
  IF EXISTS (SELECT 1 FROM instalment_allocations ia
             WHERE ia.rent_request_id = p_rent_request_id
               AND ia.source_table = p_source_table AND ia.source_id = p_source_id) THEN
    RETURN jsonb_build_object('status','already_allocated');
  END IF;

  SELECT * INTO a FROM public.allocate_instalment(p_rent_request_id, p_instalment_amount);
  IF (a.principal_component + a.registration_fee_component + a.access_fee_component) <= 0 THEN
    RETURN jsonb_build_object('status','no_allocation');
  END IF;

  SELECT COALESCE(SUM(ia.agent_commission_component),0),
         COALESCE(SUM(ia.partner_reward_component),0),
         COALESCE(SUM(ia.access_fee_component),0)
    INTO v_prior_agent, v_prior_partner, v_cum_access
  FROM instalment_allocations ia WHERE ia.rent_request_id = p_rent_request_id;

  v_agent        := ROUND(a.cumulative_after * 0.10) - v_prior_agent;
  v_plan_partner := ROUND(v_p * 0.15 * (v_d / 30.0));
  v_cum_access   := v_cum_access + a.access_fee_component;
  v_partner      := CASE WHEN v_plan_access > 0
                         THEN ROUND(v_plan_partner * v_cum_access / v_plan_access) - v_prior_partner
                         ELSE 0 END;
  v_net          := a.access_fee_component - v_agent - v_partner;
  v_r1           := a.access_fee_component + a.registration_fee_component - v_agent;
  v_key          := COALESCE(p_idempotency_key,
                             'waterfall:' || p_rent_request_id::text || ':' || v_inst_id::text);

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
                              ELSE 'Contra-revenue: pricing subsidy on underpriced plan' END))
         ELSE '[]'::jsonb END
    ), idempotency_key := v_key) INTO v_grp;

  UPDATE instalment_allocations SET transaction_group_id = v_grp WHERE instalment_id = v_inst_id;

  RETURN jsonb_build_object('status','posted','instalment_id',v_inst_id,'transaction_group_id',v_grp,
    'principal',a.principal_component,'registration',a.registration_fee_component,
    'access',a.access_fee_component,'partner_reward_allocation',v_partner,
    'agent_commission',v_agent,'platform_net',v_net,'r1_amount',v_r1);
END $fn$;
