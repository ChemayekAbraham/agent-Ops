-- Bug 1: the collection screen showed weekly plans a DAILY amount.
--
-- `agent_expected_collection` is what the agent's collect dialog offers and what
-- gets stamped on the receipt as `expected_amount` / `shortfall_amount` /
-- `is_partial`. It was:
--
--   LEAST(rr.daily_repayment, outstanding)
--
-- with no awareness of `repayment_frequency` and no reference to whether the
-- plan is actually due today. Two consequences, measured 2026-09-09:
--
--   * On the one weekly plan whose instalment was genuinely due, the screen
--     offered 16,111 against a real bill of 112,777 — exactly one seventh. The
--     agent under-collects and the receipt is stamped `is_partial` with a
--     96,666 shortfall through no fault of the tenant.
--   * On the 10 weekly plans where nothing was due, it still offered a daily
--     amount — 597,153 in total — so agents collect on days the plan is not
--     billed, and that cash can only ever be counted as arrears.
--
-- The daily plans had the same defect, just less visibly: the screen offered
-- 11,000,360 across 645 plans against a pinned bill of 3,354,637, because it
-- offered `daily_repayment` on every plan every day regardless of the schedule.
--
-- Fix: read today's instalment from the pinned bill — the same figure the
-- Agent Operations dashboard and the reports use — capped at what the tenant
-- still owes. The screen and the bill can now never disagree.
--
--   * `agent_expected_day_plans` is keyed (day, rent_request_id) as its primary
--     key, so this is an index seek, not a scan.
--   * A plan with no row for a pinned day is simply not due: return 0 directly.
--     This arm matters for performance, not just clarity. Without it the
--     schedule-generator fallback fired for every plan absent from today's bill
--     (468 of 645 daily plans), and that generator expands every plan's whole
--     instalment series before filtering: measured 43.6 ms / 6,692 buffers per
--     call versus 1.6 ms / 344 buffers with the short-circuit in place.
--   * Only if the day was never pinned at all does it fall back to
--     `rent_plan_schedule_days`. The cron has pinned every day since 2026-06-11
--     with no gaps, so in practice that arm never runs.
--   * Returns 0 when the plan is not due today. That is correct and safe:
--     `agent_allocate_tenant_payment` treats expectation as TRACKING ONLY and
--     never blocks, and `is_partial` is `expected > 0 AND amount < expected`,
--     so a non-due day is no longer mislabelled as a partial payment. Arrears
--     collection stays fully possible.
--
-- UI note for the frontend owner: the collect dialog suggests
-- `expected > 0 ? min(expected, maxAllowable) : maxAllowable`. With a correct 0
-- on non-due days the default suggestion becomes the full outstanding balance
-- rather than a spurious daily figure. That is the pre-existing "unknown"
-- branch, not a new one, but it is a visible change and may want tuning.
--
-- Signature, LANGUAGE sql, STABLE, SECURITY DEFINER and search_path unchanged.

CREATE OR REPLACE FUNCTION public.agent_expected_collection(p_rent_request_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH d AS (SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS today)
  SELECT GREATEST(
           0,
           LEAST(
             COALESCE(
               -- 1. authoritative: today's pinned instalment for this plan
               (SELECT ep.expected_ugx
                  FROM public.agent_expected_day_plans ep, d
                 WHERE ep.rent_request_id = p_rent_request_id
                   AND ep.day = d.today),
               -- 2. the day IS pinned but this plan has no row: nothing due today.
               --    Returning 0 here stops COALESCE before the costly arm below.
               (SELECT 0::numeric
                  FROM d
                 WHERE EXISTS (SELECT 1
                                 FROM public.agent_expected_day_plans ep2
                                WHERE ep2.day = d.today)),
               -- 3. only if the day was never pinned at all (cron failure)
               (SELECT COALESCE(SUM(s.amount), 0)
                  FROM d, public.rent_plan_schedule_days(d.today, d.today) s
                 WHERE s.rent_request_id = p_rent_request_id),
               0
             ),
             GREATEST(0, COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0))
           )
         )
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_expected_collection(uuid) TO authenticated, service_role;
