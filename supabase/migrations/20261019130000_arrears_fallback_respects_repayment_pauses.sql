-- The arrears fallback must honour a repayment pause.
--
-- pin_agent_expected_day bills in two passes. Pass 1 (in-term, off
-- rent_plan_schedule_days) already respects rent_repayment_pauses. Pass 2, the
-- arrears fallback for past-term plans, does not — and until 20261019104000
-- removed its `agents_with_bill` guard, pass 2 never ran, so the omission was
-- invisible.
--
-- The first run exposed it: Muhindo Brian's plan (term ended 2026-06-16, UGX
-- 1,013,040 outstanding) was paused on 2026-10-15 with the reason "TENANT RAN
-- AWAY; HE'S UNDER PURSUIT", and pass 2 put him straight back on his agent's
-- bill at 18,023/day. The agent billed for him is the same person who reported
-- him absconded.
--
-- A pause means do not collect and do not score the agent on this tenant.
-- v_agent_daily_eligibility already excludes paused plans, so the agent's own
-- card was right while the pin was wrong — but the pin is what the Agent Ops
-- reports read, so they over-billed.
DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pin_agent_expected_day';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'pin_agent_expected_day not found';
  END IF;

  v_old := '      and coalesce(rr.assigned_agent_id, rr.agent_id) is not null';

  v_new := '      and coalesce(rr.assigned_agent_id, rr.agent_id) is not null
      and not exists (
        select 1
        from public.rent_repayment_pauses z
        where z.rent_request_id = rr.id
          and z.status = ''active''
          and z.resumed_at is null
          and (z.resume_on is null or z.resume_on >= p_day)
      )';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'pin_agent_expected_day: arrears fallback agent clause not found in the shape this migration expects';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;

-- Remove the rows the un-paused fallback already wrote today.
--
-- Scoped hard: only days on or after the arrears go-live (so no reported day is
-- rewritten), only plans under an active pause covering that day, and only
-- where NO collection has been recorded against the plan that day — a bill line
-- money has landed against is never deleted, whatever its state.
DO $mig$
DECLARE
  v_removed int := 0;
  v_ugx numeric := 0;
BEGIN
  WITH doomed AS (
    SELECT p.day, p.rent_request_id, p.expected_ugx
    FROM public.agent_expected_day_plans p
    WHERE p.day >= public.agent_arrears_billing_go_live()
      AND EXISTS (
        SELECT 1 FROM public.rent_repayment_pauses z
        WHERE z.rent_request_id = p.rent_request_id
          AND z.status = 'active'
          AND z.resumed_at IS NULL
          AND (z.resume_on IS NULL OR z.resume_on >= p.day)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.agent_collections ac
        WHERE ac.rent_request_id = p.rent_request_id
          AND ac.reversed_at IS NULL
          AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = p.day
      )
  ), gone AS (
    DELETE FROM public.agent_expected_day_plans t
    USING doomed d
    WHERE t.day = d.day AND t.rent_request_id = d.rent_request_id
    RETURNING t.expected_ugx
  )
  SELECT count(*), COALESCE(sum(expected_ugx), 0) INTO v_removed, v_ugx FROM gone;

  RAISE NOTICE 'paused plans unbilled: % rows, UGX %', v_removed, v_ugx;
END
$mig$;
