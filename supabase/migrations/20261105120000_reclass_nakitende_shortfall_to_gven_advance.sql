-- NOT YET RUN. Terms decided 2026-11-05: expiry extended to cover the larger balance (instalment unchanged). Dry-run with these terms passed and rolled back 2026-11-05 (see HANDOVER 257).
--
-- Move Nakitende Jumeirah's unrecovered Rent Plan receivable (plan 406ed7bc, about 332,000 left in A3)
-- onto GVEN AKANDWANAHO's advance d0c44c3c, as decided by the CTO and the CFO on 2026-11-05
-- ("Option A: Gven must carry it").
--
-- WHY
-- Gven collected this tenant's rent and did not remit it. Doc 254 closed the plan and waived the
-- tenant's balance but posted no ledger legs, so the A3 receivable (400,000 created - 64,000 restated
-- - 4,000 collected = 332,000) is still on the books with nobody owing it. The 28 Oct advance top-up
-- (topup bdf7dc99) paid Gven 300,000 in cash and did not touch the tenant side.
--
-- WHAT THIS DOES (one transaction)
-- 1. Raises advances d0c44c3c.outstanding_balance by v_amt with a statement row (the
--    zz_advance_balance_must_be_on_statement trigger writes it from the adjustment note), and
--    extends expires_at / cycle_days so the unchanged daily instalment clears the new balance:
--    days needed = ceil(new balance / daily instalment) + 1 spare day, counted from the run date.
--    The expiry only ever moves later (GREATEST), never earlier.
-- 2. Posts ONE balanced platform group (balanced on base mapping alone, no wallet effect):
--      DR A10  agent_advance_disbursement  cash_out  v_amt   (agent owes the company)
--      CR A3   tenant_repayment            cash_in   v_amt   (tenant receivable cleared)
-- 3. Audit row 'rent_plan_shortfall_reclassed_to_agent_advance' under the CFO's id.
-- Nothing touches Gven's wallet; nothing is recognised as revenue.
--
-- RUN AS: SARAH ANGWEN (CFO) 29a0cfa8-1eaf-453c-874c-0fc72fa4f74b. Idempotent. Aborts without changes
-- if the plan, the advance, the agent or the A3 balance are not exactly as approved.
--
-- TERMS (CFO decision 2026-11-05): extend the expiry; the daily instalment stays 16,417.
-- Without this the larger balance could not clear by the old expiry (2026-12-15) and would go
-- overdue and attract the 0.8263%/day overdue penalty.
-- STILL OPEN: Gven should be told. This file sends no notification.

DO $$
DECLARE
  v_plan     uuid    := '406ed7bc-e837-4617-9110-cabb4b84313b';
  v_tenant   uuid    := '51d99b2c-d3ac-41dd-82fb-0481c5109bc1';
  v_agent    uuid    := '04ef6aad-ade8-4dbc-ae3f-09669a836952';
  v_advance  uuid    := 'd0c44c3c-05b6-4994-acde-ade82e467c6c';
  v_by       uuid    := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  v_expected numeric := 332000;
  v_a3       numeric;
  v_amt      numeric;
  v_adv      record;
  v_note     text;
  v_group    uuid;
  v_days     integer;
  v_exp_old  timestamptz;
  v_exp_new  timestamptz;
  v_ext      integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_by AND role::text = 'cfo') THEN
    RAISE EXCEPTION 'Actor % does not hold the cfo role; refusing to run', v_by;
  END IF;

  IF EXISTS (SELECT 1 FROM public.audit_logs
              WHERE action_type = 'rent_plan_shortfall_reclassed_to_agent_advance'
                AND table_name = 'rent_requests' AND record_id = v_plan::text) THEN
    RAISE NOTICE 'Already reclassed; nothing to do';
    RETURN;
  END IF;

  -- The plan has since been transferred to another agent by Tenant Ops (2026-11-02/03), so rent_requests.agent_id
  -- is no longer Gven. The responsible agent is the one named in the CFO waiver audit row (doc 254).
  IF NOT EXISTS (SELECT 1 FROM public.rent_requests
                  WHERE id = v_plan AND tenant_id = v_tenant AND status = 'completed')
     OR NOT EXISTS (SELECT 1 FROM public.audit_logs
                     WHERE action_type = 'rent_plan_balance_waived_agent_advance'
                       AND table_name = 'rent_requests' AND record_id = v_plan::text
                       AND metadata->>'agent_id' = v_agent::text
                       AND metadata->>'agent_advance_id' = v_advance::text) THEN
    RAISE EXCEPTION 'Plan % is not the completed plan waived against agent % / advance %', v_plan, v_agent, v_advance;
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = v_advance FOR UPDATE;
  IF NOT FOUND OR v_adv.agent_id IS DISTINCT FROM v_agent OR v_adv.status NOT IN ('active', 'overdue', 'repaying') THEN
    RAISE EXCEPTION 'Advance % is not an open advance of agent %', v_advance, v_agent;
  END IF;

  -- Current A3 balance of every group that carries this plan (or its collections) on the resolved ledger.
  WITH ids AS (
    SELECT v_plan AS id
    UNION SELECT id FROM public.agent_collections WHERE rent_request_id = v_plan
  ), grp AS (
    SELECT DISTINCT transaction_group_id AS g FROM public.general_ledger
     WHERE source_id IN (SELECT id FROM ids) OR reference_id IN (SELECT id::text FROM ids)
  )
  SELECT COALESCE(SUM(s.dr) - SUM(s.cr), 0) INTO v_a3
    FROM public.sofp_ledger_legs(now()) s JOIN grp ON grp.g = s.transaction_group_id
   WHERE s.account_code = 'A3';

  IF v_a3 IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'A3 balance for plan % is %, expected %; aborting without changes', v_plan, v_a3, v_expected;
  END IF;
  v_amt := v_a3;

  v_note := 'CFO: tenant shortfall of plan 406ed7bc (Nakitende Jumeirah) moved onto agent advance; agent collected the rent and did not remit';
  PERFORM set_config('welile.advance_adjustment_note', v_note, true);

  v_exp_old := v_adv.expires_at;
  v_days    := ceil((v_adv.outstanding_balance + v_amt) / NULLIF(v_adv.daily_installment, 0))::int + 1;
  v_exp_new := GREATEST(v_exp_old, now() + make_interval(days => v_days));
  v_ext     := ceil(extract(epoch FROM (v_exp_new - v_exp_old)) / 86400)::int;

  UPDATE public.agent_advances
     SET outstanding_balance = outstanding_balance + v_amt,
         expires_at = v_exp_new,
         cycle_days = COALESCE(cycle_days, 0) + v_ext,
         updated_at = now()
   WHERE id = v_advance;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', v_amt, 'category', 'agent_advance_disbursement',
        'source_table', 'agent_advances', 'source_id', v_advance,
        'description', 'Tenant shortfall (plan 406ed7bc, Nakitende Jumeirah) charged to agent advance - no cash paid',
        'currency', 'UGX', 'transaction_date', now()),
      jsonb_build_object(
        'user_id', v_tenant, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', v_amt, 'category', 'tenant_repayment',
        'source_table', 'rent_requests', 'source_id', v_plan,
        'description', 'Tenant receivable cleared: shortfall charged to agent advance (CFO ruling)',
        'currency', 'UGX', 'transaction_date', now())
    ),
    'reclass_shortfall_to_advance:' || v_plan::text,
    false);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_by, 'rent_plan_shortfall_reclassed_to_agent_advance', 'rent_requests', v_plan::text, v_note,
    jsonb_build_object(
      'agent_id', v_agent, 'tenant_id', v_tenant, 'agent_advance_id', v_advance,
      'amount', v_amt, 'a3_before', v_a3, 'a3_after', 0,
      'advance_outstanding_before', v_adv.outstanding_balance,
      'advance_outstanding_after', v_adv.outstanding_balance + v_amt,
      'expires_at_before', v_exp_old, 'expires_at_after', v_exp_new, 'cycle_days_added', v_ext,
      'transaction_group_id', v_group, 'topup_ref', 'bdf7dc99-1f22-4a32-badf-945c93ccce89'));
END $$;
