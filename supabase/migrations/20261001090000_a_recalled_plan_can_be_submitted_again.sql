-- A recalled Rent Plan can be submitted again.
--
-- The 24-hour landlord float recall cancels the plan and returns the float to
-- the pool. Both SMS messages say so in as many words — A4 to the agent and T2
-- to the tenant both end "can be submitted again" — and then nothing in the
-- product let the agent do it.
--
-- WHY IT WAS IMPOSSIBLE, IN THREE PLACES
--
-- `cancel_tenant_and_return_landlord_float` sets `status = 'cancelled'` and
-- leaves `rejected_at`, `rejected_reason` and `rejected_at_stage` NULL, because
-- nobody rejected anything. It also sets `tenancy_status = 'terminated'` and
-- `agent_payment_status = 'not_paying'`.
--
--   1. The agent's Rejected Requests queue selects `status = 'rejected'`, so a
--      recalled plan appeared on no queue at all.
--   2. `agent_resubmit_rent_request` refused: "Only rejected requests can be
--      resubmitted (current status: cancelled)".
--   3. `agent_delete_rejected_rent_request` refused for the same reason, so the
--      agent could not even dismiss it.
--
-- Measured 2026-10-01: tenant Aaron Gwokto, plan 9C078BF7, recalled
-- 2026-09-29 19:10 Kampala after the landlord went unpaid for 24 hours. The
-- tenant was stranded — no plan, no queue entry, no way back.
--
-- WHAT COUNTS AS RECALLED
--
-- `rent_plan_returned_for_resubmission` is deliberately narrow. It is NOT
-- "status = cancelled": an Ops cancellation is not the agent's to retry. It
-- requires an `auto_recalled` outcome on `landlord_float_idle_alerts`, which
-- only the recall writes, AND that nothing was ever collected, so there is
-- nothing to unwind. Exactly one plan on the platform matches today.
--
-- ON THE REOPEN ALLOWANCE
--
-- A recall DOES consume one of the five resubmits. `rent_request_stale_return`
-- exists for returns that are not the agent's doing, and this is not one of
-- them: the agent held the float for 24 hours and did not pay the landlord.
-- Five attempts is ample, and letting recalls churn float for free is the
-- behaviour the recall was built to stop. Flip it by adding the recall to
-- `rent_request_stale_return` if that judgement turns out to be wrong.

-- 1. One definition of "the float came back, try again" --------------------
CREATE OR REPLACE FUNCTION public.rent_plan_returned_for_resubmission(p_rent_request_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.rent_requests rr
     WHERE rr.id = p_rent_request_id
       AND rr.status = 'cancelled'
       -- Nothing was ever collected, so there is nothing to unwind.
       AND COALESCE(rr.amount_repaid, 0) = 0
       -- The 24-hour recall is the only writer of this outcome.
       AND EXISTS (
         SELECT 1 FROM public.landlord_float_idle_alerts al
          WHERE al.rent_request_id = rr.id
            AND al.outcome = 'auto_recalled')
  );
$function$;

COMMENT ON FUNCTION public.rent_plan_returned_for_resubmission(uuid) IS
  'True when the 24-hour landlord float recall cancelled this plan and nothing '
  'was ever collected on it. The landlord was never paid and the float is back '
  'in the pool, so the agent may submit the same request again. Distinct from '
  'an ops cancellation, which this never matches.';

GRANT EXECUTE ON FUNCTION public.rent_plan_returned_for_resubmission(uuid)
  TO authenticated, service_role;

-- 2. Resubmit accepts a recalled plan, and puts the tenant back on their feet
--
-- The status reset matters as much as the gate. The recall left the plan
-- `terminated` / `not_paying`, and `v_agent_daily_eligibility` excludes
-- `not_paying` outright — so a resubmitted plan would have gone back into
-- review still carrying a written-off tenant.
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_resubmit_rent_request';
  IF v_src IS NULL THEN RAISE EXCEPTION 'agent_resubmit_rent_request not found'; END IF;
  IF v_src LIKE '%rent_plan_returned_for_resubmission%' THEN
    RAISE NOTICE 'Already applied - resubmit already accepts recalled plans.';
    RETURN;
  END IF;

  v_new := replace(v_src,
$a$  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be resubmitted (current status: %)', _row.status;
  END IF;$a$,
$b$  -- A plan the 24-hour landlord float recall cancelled is resubmittable too.
  -- The landlord was never paid and the float went back to the pool, so there
  -- is nothing to unwind: the agent simply has to try again. Without this the
  -- tenant is stranded, because a recalled plan is 'cancelled' and never
  -- 'rejected', so it appears on no queue the agent can act on.
  IF _row.status <> 'rejected'
     AND NOT public.rent_plan_returned_for_resubmission(p_request_id) THEN
    RAISE EXCEPTION 'Only rejected or recalled requests can be resubmitted (current status: %)', _row.status;
  END IF;$b$);
  IF v_new = v_src THEN RAISE EXCEPTION 'status gate anchor not found'; END IF;
  v_src := v_new;

  v_new := replace(v_src,
'         status = _next_status, rejected_at = NULL, rejected_reason = NULL, rejected_at_stage = NULL,',
'         status = _next_status, rejected_at = NULL, rejected_reason = NULL, rejected_at_stage = NULL,
         tenancy_status = ''active'',
         agent_payment_status = ''paying'',
         agent_payment_status_reason = NULL,
         agent_payment_status_set_at = now(),
         agent_payment_status_set_by = auth.uid(),');
  IF v_new = v_src THEN RAISE EXCEPTION 'SET list anchor not found'; END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.agent_resubmit_rent_request(
       p_request_id uuid, p_patch jsonb, p_agent_note text)
     RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;

-- 3. Delete accepts it too ---------------------------------------------------
--
-- The row is in the agent's queue now, so the Delete button beside Resubmit has
-- to work on it or it is a dead control. Rebuilt from pg_get_functiondef so the
-- signature comes from the database rather than from a guess.
DO $patch$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_delete_rejected_rent_request';
  IF v_def IS NULL THEN RAISE EXCEPTION 'agent_delete_rejected_rent_request not found'; END IF;
  IF v_def LIKE '%rent_plan_returned_for_resubmission%' THEN
    RAISE NOTICE 'Already applied - delete already accepts recalled plans.';
    RETURN;
  END IF;

  v_new := replace(v_def,
$a$  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be deleted (current status: %)', _row.status;
  END IF;$a$,
$b$  -- A recalled plan is in the same queue and may be dismissed the same way.
  IF _row.status <> 'rejected'
     AND NOT public.rent_plan_returned_for_resubmission(p_request_id) THEN
    RAISE EXCEPTION 'Only rejected or recalled requests can be deleted (current status: %)', _row.status;
  END IF;$b$);
  IF v_new = v_def THEN RAISE EXCEPTION 'delete gate anchor not found'; END IF;

  EXECUTE v_new;
END
$patch$;

-- Proved on a rolled-back transaction against production, as the plan's own
-- agent, on the recalled plan 9C078BF7:
--   status=pending  tenancy=active  agent_payment=paying  reopen=1  resubmits=1
