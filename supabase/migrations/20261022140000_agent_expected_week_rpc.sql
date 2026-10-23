-- The real 7-day bill, instead of today's bill multiplied by seven.
--
-- Three agent-facing surfaces built a "weekly target" as `expected_daily * 7`:
--   src/components/executive/AgentProfile360Sheet.tsx
--   src/components/executive/AgentRentCapacityPanel.tsx
--   src/components/agent/AgentRentCapacitySelfCard.tsx
--
-- That is not a target, it is an extrapolation of today across six days that
-- have already happened — so it is RESTATED RETROACTIVELY whenever an agent's
-- daily bill changes. NATTU SHARIFAH, measured 2026-10-22: her real bill over
-- the last seven days was 1,525,490 (214,110 / 197,946 / 197,946 / 214,130 /
-- 214,130 / 243,614 / 243,614, rising as her book went from 10 tenants to 12).
-- The cards showed 243,614 * 7 = 1,705,298, overstating it by 179,808, so her
-- 769,856 collected read 45% instead of 50%. When she took on her 12th tenant
-- the target for the six FINISHED days jumped too and the same collections fell
-- from 51% to 45%. That is the "it keeps dropping while I collect" complaint.
--
-- Two of those surfaces also took their numerator from `repayments`, which held
-- 145 rows platform-wide in seven days against 1,547 in `agent_collections`,
-- and none at all for this agent. So this returns both sides from one place:
-- the pinned bill and the collections that answer it, over the same days.
--
-- READ-ONLY. No INSERT, UPDATE or DELETE. The pinned bill in
-- `agent_expected_day_plans` is read and never written, so nothing here can
-- change what an agent was billed.

CREATE OR REPLACE FUNCTION public.agent_expected_week__impl(
  p_agent_ids uuid[],
  p_days      int
)
RETURNS TABLE (
  agent_id       uuid,
  expected_week  numeric,
  collected_week numeric,
  days_billed    int,
  day_from       date,
  day_to         date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH w AS (
    SELECT ((now() AT TIME ZONE 'Africa/Kampala')::date
              - (GREATEST(COALESCE(p_days, 7), 1) - 1)) AS lo,
           ((now() AT TIME ZONE 'Africa/Kampala')::date) AS hi
  ), ids AS (
    SELECT DISTINCT a.id FROM unnest(p_agent_ids) a(id) WHERE a.id IS NOT NULL
  ), bill AS (
    -- The pinned bill: exactly what the posting gate and the collections
    -- report measure against.
    SELECT e.agent_id, sum(e.expected_ugx) AS exp_sum, count(DISTINCT e.day) AS d_cnt
    FROM public.agent_expected_day_plans e, w
    WHERE e.day BETWEEN w.lo AND w.hi
      AND e.agent_id IN (SELECT id FROM ids)
    GROUP BY e.agent_id
  ), coll AS (
    -- Bounded on created_at so the index is usable; the bounds are Kampala
    -- local midnights, matching the day keys above.
    SELECT c.agent_id, sum(c.amount) AS coll_sum
    FROM public.agent_collections c, w
    WHERE c.reversed_at IS NULL
      AND c.created_at >= (w.lo::timestamp AT TIME ZONE 'Africa/Kampala')
      AND c.created_at <  ((w.hi + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
      AND c.agent_id IN (SELECT id FROM ids)
    GROUP BY c.agent_id
  )
  SELECT ids.id,
         COALESCE(bill.exp_sum, 0)::numeric,
         COALESCE(coll.coll_sum, 0)::numeric,
         COALESCE(bill.d_cnt, 0)::int,
         (SELECT lo FROM w),
         (SELECT hi FROM w)
  FROM ids
  LEFT JOIN bill ON bill.agent_id = ids.id
  LEFT JOIN coll ON coll.agent_id = ids.id;
$fn$;

-- Caller gate mirrors get_agent_daily_eligibility exactly: staff may read any
-- agent; anyone else only themselves or their own wallet network.
CREATE OR REPLACE FUNCTION public.agent_expected_week(
  p_agent_ids uuid[],
  p_days      int DEFAULT 7
)
RETURNS TABLE (
  agent_id       uuid,
  expected_week  numeric,
  collected_week numeric,
  days_billed    int,
  day_from       date,
  day_to         date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF public._direct_client_call() THEN
    IF NOT (
      public.can_view_staff_reports(auth.uid())
      OR NOT EXISTS (
        SELECT 1 FROM unnest(p_agent_ids) a(id)
        WHERE a.id IS DISTINCT FROM auth.uid()
          AND a.id NOT IN (SELECT public.agent_wallet_network_ids(auth.uid()))
      )
    ) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN QUERY SELECT * FROM public.agent_expected_week__impl($1, $2);
END
$fn$;

-- Closed by default (doc 247 step 23): the browser calls the guarded wrapper
-- only. __impl stays owner/service_role.
GRANT EXECUTE ON FUNCTION public.agent_expected_week(uuid[], int) TO authenticated;

COMMENT ON FUNCTION public.agent_expected_week(uuid[], int) IS
  'Per agent over the last p_days Kampala days: the summed PINNED bill and the non-reversed collections answering it. Read-only. Replaces the expected_daily*7 extrapolation that restated finished days whenever an agent''s daily bill changed.';
