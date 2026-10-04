-- Patience Ruba: repayment starts 25 September, not 18.
--
-- THE REPORT
-- The agent's "Call these 1 tenant NOW" banner showed her 6 days behind with
-- UGX 123,702 overdue, on a plan the product owner says starts tomorrow.
--
-- WHAT THE RECORD SAID, AND WHY THE NUMBER WAS NOT A BUG
--   funded                 2026-09-17 11:20 EAT
--   repayment_starts_on    2026-09-18   (funded + 1 day, the platform rule)
--   daily_repayment        20,617
--   collections ever       0
--   pinned bill            18-24 Sept, seven days, 144,319 total
--
-- 123,702 / 20,617 = exactly 6 - days 18 to 23, correctly excluding today. The
-- arrears engine, the pinned bill and the banner all agreed with each other,
-- and 1,350 other funded plans carry the same funded+1 rule. Nothing was
-- miscalculating; the start date itself was wrong for this tenant.
--
-- THE DECISION (product owner, 2026-09-24): "exempt her to start tomorrow,
-- clear those missed days."
--
-- WHY THIS DELETES PINNED ROWS, WHICH IS NORMALLY FORBIDDEN
-- `agent_expected_day_plans` is the bill: written once at 00:05 EAT and never
-- changed. `ops_set_rent_plan_frequency` respects that - it clears pins only
-- from TODAY forward, deliberately leaving history alone - which is why it is
-- not the right tool here and is not being used.
--
-- The distinction that makes this safe: those seven rows are not history being
-- rewritten, they are a bill produced from a start date that should never have
-- been 18 September. The pin is DERIVED from `repayment_starts_on`; correcting
-- the source without withdrawing what it generated would leave her permanently
-- six days behind on days she was never meant to owe.
--
-- Scope is one plan and only days before the new start. Nothing else is
-- touched, and the deletion is recorded in audit_logs with the reason.
--
-- NO MONEY MOVES. She has made no collections, so there are no
-- `rent_day_settlements` rows against these days and nothing to re-allocate.
-- No wallet, ledger or receipt row is involved.

DO $fix$
DECLARE
  v_plan    uuid := '6789bb19-3cca-4fee-908b-6f0bbe89e507';
  v_new     date := DATE '2026-09-25';
  v_rr      public.rent_requests;
  v_pins    int  := 0;
  v_amount  numeric := 0;
  v_settled int  := 0;
BEGIN
  SELECT * INTO v_rr FROM public.rent_requests WHERE id = v_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rent request % not found', v_plan;
  END IF;

  -- Refuse if this is not the plan that was reviewed.
  IF v_rr.tenant_id IS DISTINCT FROM '1a470d4a-41d9-48d8-ae84-9c6f3c583c23'::uuid THEN
    RAISE EXCEPTION 'plan % belongs to a different tenant than the one reviewed - inspect by hand', v_plan;
  END IF;

  IF v_rr.repayment_starts_on = v_new THEN
    RAISE NOTICE 'already starts %, nothing to do', v_new;
    RETURN;
  END IF;

  -- Money against these days would mean this is NOT simply an unbilled period,
  -- and deleting the bill would strand a real payment.
  SELECT count(*) INTO v_settled
    FROM public.rent_day_settlements s
   WHERE s.rent_request_id = v_plan AND s.day < v_new;
  IF v_settled > 0 THEN
    RAISE EXCEPTION
      '% settlement row(s) exist before % - money was received against days being un-billed, rolled back',
      v_settled, v_new;
  END IF;

  SELECT count(*), COALESCE(sum(expected_ugx), 0) INTO v_pins, v_amount
    FROM public.agent_expected_day_plans
   WHERE rent_request_id = v_plan AND day < v_new;

  DELETE FROM public.agent_expected_day_plans
   WHERE rent_request_id = v_plan AND day < v_new;

  UPDATE public.rent_requests
     SET repayment_starts_on = v_new,
         updated_at = now()
   WHERE id = v_plan;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    NULL,
    'ops.rent_plan_start_deferred',
    'rent_requests',
    v_plan::text,
    jsonb_build_object(
      'reason', 'Product owner 2026-09-24: tenant starts paying 25 September; the plan was funded '
             || '17 September and took the default funded+1 start, billing seven days she was never '
             || 'meant to owe. Start corrected and the bill for those days withdrawn.',
      'tenant_id', v_rr.tenant_id,
      'tenant_name', 'Patience Ruba',
      'agent_id', COALESCE(v_rr.assigned_agent_id, v_rr.agent_id),
      'previous_repayment_starts_on', v_rr.repayment_starts_on,
      'new_repayment_starts_on', v_new,
      'funded_at', v_rr.funded_at,
      'daily_repayment', v_rr.daily_repayment,
      'pins_deleted', v_pins,
      'billed_amount_withdrawn', v_amount,
      'collections_against_those_days', 0)
  );

  RAISE NOTICE 'Patience Ruba: start % -> %, % pinned day(s) withdrawn totalling %',
    v_rr.repayment_starts_on, v_new, v_pins, v_amount;
END $fix$;

-- Verify --------------------------------------------------------------------
DO $verify$
DECLARE
  v_plan uuid := '6789bb19-3cca-4fee-908b-6f0bbe89e507';
  v_arrears numeric; v_left int; v_start date;
BEGIN
  SELECT repayment_starts_on INTO v_start FROM public.rent_requests WHERE id = v_plan;
  IF v_start <> DATE '2026-09-25' THEN
    RAISE EXCEPTION 'start date is % not 2026-09-25 - rolled back', v_start;
  END IF;

  SELECT count(*) INTO v_left
    FROM public.agent_expected_day_plans
   WHERE rent_request_id = v_plan AND day < DATE '2026-09-25';
  IF v_left > 0 THEN
    RAISE EXCEPTION '% pinned day(s) still billed before the new start - rolled back', v_left;
  END IF;

  -- The figure the agent's banner reads.
  v_arrears := public.rent_plan_arrears_ugx(v_plan);
  IF COALESCE(v_arrears, 0) <> 0 THEN
    RAISE EXCEPTION 'arrears still % after the fix - rolled back', v_arrears;
  END IF;

  -- Blast radius: exactly one plan may have lost pinned days today.
  IF (SELECT count(DISTINCT record_id) FROM public.audit_logs
       WHERE action_type = 'ops.rent_plan_start_deferred'
         AND created_at >= now() - interval '5 minutes') > 1 THEN
    RAISE EXCEPTION 'more than one plan was altered - rolled back';
  END IF;

  RAISE NOTICE 'Patience Ruba: arrears now 0, repayment starts 2026-09-25';
END $verify$;
