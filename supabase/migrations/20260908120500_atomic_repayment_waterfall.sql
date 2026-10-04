-- PHASE 2 CALLERS (2/2): atomic repayment + waterfall.
--
-- PREPARED, NOT APPLIED. Nothing in this file has been run against production.
--
-- THE TRANSACTION-BOUNDARY PROBLEM THIS SOLVES
-- tenant-pay-rent currently makes THREE separate RPC round-trips, each its own
-- database transaction:
--     line 124  create_ledger_transaction        (wallet + platform legs)
--     line 167  record_rent_request_repayment    (rent_requests update)
--     line 181  credit_agent_rent_commission     (commission)
-- The function already acknowledges the gap at line 175:
--     "Payment recorded but repayment update failed. Contact support." partial:true
--
-- Adding the waterfall as a FOURTH round-trip would therefore be non-atomic: a
-- failure after the repayment was recorded would leave a payment with no
-- allocation, or an allocation with no payment. Because a PL/pgSQL function runs
-- in a single transaction, folding the repayment and the waterfall into one
-- function makes those two atomic together.
--
-- RESIDUAL GAP, STATED PLAINLY: the step-124 ledger legs remain a SEPARATE
-- transaction. That gap is pre-existing and is NOT introduced here. Closing it
-- fully would require folding all three calls into one function - a larger
-- refactor of a live money path that should be decided on its own merits.
--
-- ORDERING
--   1. assert_funding_treasury_recognised()  - fail fast on the L7 sequencing rule
--   2. record_rent_request_repayment()       - unchanged existing logic
--   3. post_instalment_waterfall()           - allocation spine + Treasury legs
-- Any failure rolls back all three.
--
-- IDEMPOTENCY: post_instalment_waterfall() keys on
-- (rent_request_id, source_table, source_id) and returns 'already_allocated'
-- on a retry, so a replayed payment cannot create a second allocation row or
-- duplicate GL legs, and cannot drive L7 further into debit.
--
-- BD-2 is preserved end to end: partner_reward_component is recorded as an
-- attribution only. No partner_reward_accrued leg, no L3 credit.

CREATE OR REPLACE FUNCTION public.record_rent_request_repayment_v2(
  p_tenant_id uuid,
  p_amount numeric,
  p_source_table text DEFAULT 'tenant_pay_rent',
  p_source_id uuid DEFAULT NULL,
  p_transaction_group_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_rr uuid; v_src uuid := COALESCE(p_source_id, gen_random_uuid()); v_wf jsonb;
BEGIN
  SELECT id INTO v_rr FROM rent_requests
  WHERE tenant_id = p_tenant_id
    AND status IN ('funded','disbursed','approved','repaying')
  ORDER BY created_at DESC LIMIT 1;
  IF v_rr IS NULL THEN RAISE EXCEPTION 'No active rent request for tenant %', p_tenant_id; END IF;

  -- Hard sequencing rule: no waterfall before funding-side L7 recognition.
  PERFORM public.assert_funding_treasury_recognised(v_rr);

  -- Existing repayment logic, unchanged.
  PERFORM public.record_rent_request_repayment(p_tenant_id, p_amount, p_transaction_group_id);

  -- Allocation spine + Treasury component postings, same transaction.
  v_wf := public.post_instalment_waterfall(v_rr, p_amount, p_source_table, v_src);

  RETURN jsonb_build_object('status','ok','rent_request_id',v_rr,'waterfall',v_wf);
END $fn$;
