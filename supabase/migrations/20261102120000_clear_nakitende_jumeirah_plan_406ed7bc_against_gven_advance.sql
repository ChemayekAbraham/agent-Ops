-- Clear Nakitende Jumeirah's open Rent Plan 406ed7bc (336,000 outstanding) as approved by the CFO.
--
-- WHY
-- Agent GVEN AKANDWANAHO collected this tenant's rent money and did not remit it. The
-- shortfall was then moved onto Gven as an advance top-up (300,000 on advance d0c44c3c,
-- 2026-10-28 08:17 UTC, topped up by BAYO MERCY). The company is recovering that money from
-- Gven's wallet (16,417/day), so the tenant must not also owe it. The tenant's plan is
-- closed with the unpaid 336,000 waived.
--
-- HOW (deliberately minimal)
-- * status -> 'completed'. amount_repaid is LEFT at 216,000, so no collection, receipt,
--   commission or streak credit is manufactured for money that never arrived. Six existing
--   plans are already closed this way (completed with amount_repaid < total_repayment).
-- * v_rent_plan_arrears treats 'completed' as owing 0, so the tenant and the agent's chase
--   list both clear. Not 'cancelled': cancellation is an unwind that returns landlord float
--   and reverses fee recognition, which is wrong here (the landlord was paid).
-- * No general_ledger legs are posted. The cash side is already carried by the Gven advance.
-- * Everything is recorded in audit_logs under the CFO's id.
--
-- RUN AS: SARAH ANGWEN (CFO), user id 29a0cfa8-1eaf-453c-874c-0fc72fa4f74b.
-- The migration refuses to run unless that user holds the 'cfo' role, and writes her id as
-- the actor. It is idempotent and aborts without changing anything if the plan is not in
-- exactly the state it was approved in (status repaying, total 552,000, repaid 216,000).

DO $$
DECLARE
  v_plan    uuid    := '406ed7bc-e837-4617-9110-cabb4b84313b';
  v_tenant  uuid    := '51d99b2c-d3ac-41dd-82fb-0481c5109bc1';
  v_agent   uuid    := '04ef6aad-ade8-4dbc-ae3f-09669a836952';
  v_advance uuid    := 'd0c44c3c-05b6-4994-acde-ade82e467c6c';
  v_by      uuid    := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  v_total   numeric := 552000;
  v_repaid  numeric := 216000;
  v_waived  numeric := 336000;
  v_reason  text    := 'CFO approved: agent GVEN AKANDWANAHO collected this tenant''s rent and did not remit it; shortfall moved to the agent as an advance top-up (advance d0c44c3c, 2026-10-28). Remaining balance waived for the tenant.';
  v_rr      record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_by AND role::text = 'cfo'
  ) THEN
    RAISE EXCEPTION 'Actor % does not hold the cfo role; refusing to run', v_by;
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = v_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent plan % not found', v_plan;
  END IF;

  -- Idempotent: already cleared by an earlier run.
  IF v_rr.status = 'completed' THEN
    RAISE NOTICE 'Plan % is already completed; nothing to do', v_plan;
    RETURN;
  END IF;

  IF v_rr.tenant_id IS DISTINCT FROM v_tenant
     OR v_rr.agent_id IS DISTINCT FROM v_agent
     OR v_rr.status <> 'repaying'
     OR v_rr.total_repayment IS DISTINCT FROM v_total
     OR v_rr.amount_repaid IS DISTINCT FROM v_repaid THEN
    RAISE EXCEPTION
      'Plan % is not in the approved state (status %, total %, repaid %); aborting without changes',
      v_plan, v_rr.status, v_rr.total_repayment, v_rr.amount_repaid;
  END IF;

  UPDATE public.rent_requests
     SET status = 'completed',
         updated_at = now()
   WHERE id = v_plan;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_by, 'rent_plan_balance_waived_agent_advance', 'rent_requests', v_plan::text, v_reason,
    jsonb_build_object(
      'tenant_id', v_tenant,
      'agent_id', v_agent,
      'agent_advance_id', v_advance,
      'total_repayment', v_total,
      'amount_repaid', v_repaid,
      'waived_amount', v_waived,
      'previous_status', 'repaying',
      'new_status', 'completed',
      'ledger_legs_posted', false,
      'approved_by_role', 'cfo'
    )
  );
END $$;
