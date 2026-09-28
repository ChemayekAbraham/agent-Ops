-- Agents who have tenants due today and have stopped collecting
--
-- WHY THIS EXISTS
--
-- Measured across the week of 21-27 September, between 48% and 76% of agents
-- who had tenants billed that day collected from nobody at all. That single
-- fact is most of the collection shortfall: of 518 tenants billed over seven
-- days, 238 had ZERO visits and account for 23.6m of the 44.7m gap. Visits
-- track coverage almost exactly — 0 visits gives 0%, 3.9 visits gives 73%.
--
-- The existing surfaces could not show this. The Command Center answers "how
-- much came in", the partial-collections panel only sees tenants who already
-- paid something, and the collection-lapse alert only warns after five idle
-- days and is newer than the problem.
--
-- THE POINT OF THE `blocker` COLUMN
--
-- Two agents with identical silence need opposite interventions, and calling
-- them the same thing wastes the call:
--
--   * `no_float`  — they physically cannot collect. An agent spends their own
--     float to settle a tenant's day, so a zero balance is a hard stop, not
--     reluctance. One agent had 22 tenants due and 105 shillings. Ringing them
--     achieves nothing; funding them does.
--
--   * `silent_with_float` — they have the means and the tenants and have
--     stopped anyway. This is the group worth a phone call, and it is the
--     larger one.
--
-- `landlord_float_held` is surfaced alongside because the two populations turn
-- out to be the same people: on 28 September the seventeen agents on this list
-- were holding ~11.97m of landlord float, essentially the whole idle-float
-- backlog. Whatever causes an agent to disengage shows up as an unpaid landlord
-- and uncollected rent at the same time, so one call can clear both.

CREATE OR REPLACE FUNCTION public.agent_ops_silent_collectors(
  p_min_days_silent integer DEFAULT 3,
  p_limit           integer DEFAULT 100)
RETURNS TABLE (
  agent_id            uuid,
  agent_name          text,
  phone               text,
  days_silent         integer,
  last_collected      date,
  tenants_today       bigint,
  owed_today          numeric,
  tenants_behind      bigint,
  arrears             numeric,
  collection_float    numeric,
  withdrawable        numeric,
  landlord_float_held numeric,
  blocker             text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_min   int  := GREATEST(1, LEAST(60, COALESCE(p_min_days_silent, 3)));
  v_lim   int  := GREATEST(1, LEAST(500, COALESCE(p_limit, 100)));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent_ops'::app_role)
    OR public.has_role(v_uid, 'tenant_ops'::app_role)
    OR public.has_role(v_uid, 'operations'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'cto'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Operations role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bill AS (
    -- Today's pinned bill, per agent. The pin is the bill: since 26 September
    -- it only ever contains plans that are actually repaying, on or after the
    -- day their landlord was paid.
    SELECT e.agent_id AS aid,
           count(DISTINCT e.rent_request_id) AS tenants_today,
           sum(e.expected_ugx)               AS owed_today
    FROM public.agent_expected_day_plans e
    WHERE e.day = v_today AND e.agent_id IS NOT NULL
    GROUP BY e.agent_id
  ),
  -- Aggregated once rather than a correlated subquery per agent.
  arr AS (
    SELECT a.agent_id AS aid,
           count(*)             AS tenants_behind,
           sum(a.arrears_ugx)   AS arrears
    FROM public.v_rent_plan_arrears a
    WHERE a.arrears_ugx > 0 AND a.agent_id IS NOT NULL
    GROUP BY a.agent_id
  ),
  last_seen AS (
    SELECT c.agent_id AS aid,
           max((c.created_at AT TIME ZONE 'Africa/Kampala')::date) AS last_coll
    FROM public.agent_collections c
    WHERE c.reversed_at IS NULL
      AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED:%'
      AND c.agent_id IS NOT NULL
    GROUP BY c.agent_id
  )
  SELECT
    b.aid,
    p.full_name,
    p.phone,
    (v_today - COALESCE(ls.last_coll, v_today - 999))::int,
    ls.last_coll,
    b.tenants_today,
    b.owed_today,
    COALESCE(ar.tenants_behind, 0),
    COALESCE(ar.arrears, 0),
    COALESCE(w.float_balance, 0),
    COALESCE(w.withdrawable, 0),
    COALESCE(alf.balance, 0),
    CASE
      WHEN COALESCE(w.float_balance, 0) < b.owed_today THEN 'no_float'
      ELSE 'silent_with_float'
    END
  FROM bill b
  JOIN public.profiles p ON p.id = b.aid
  LEFT JOIN arr ar ON ar.aid = b.aid
  LEFT JOIN last_seen ls ON ls.aid = b.aid
  LEFT JOIN public.wallet_balances_projection w ON w.user_id = b.aid
  LEFT JOIN public.agent_landlord_float alf ON alf.agent_id = b.aid
  -- Never collected at all counts as maximally silent rather than being dropped.
  WHERE (v_today - COALESCE(ls.last_coll, v_today - 999)) >= v_min
  ORDER BY b.owed_today DESC
  LIMIT v_lim;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_ops_silent_collectors(integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_silent_collectors(integer, integer) TO authenticated;

COMMENT ON FUNCTION public.agent_ops_silent_collectors(integer, integer) IS
  'Agents with tenants billed today who have not collected for N days. '
  '`blocker` separates the two cases that need opposite handling: no_float '
  'cannot collect and needs funding, silent_with_float has the means and needs '
  'a phone call. landlord_float_held is shown because the same agents tend to '
  'be sitting on unpaid landlord money.';
