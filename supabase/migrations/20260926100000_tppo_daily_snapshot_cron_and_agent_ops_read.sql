-- Keep the daily collections snapshot current, and let Agent Ops read it
--
-- `tppo_period_snapshots` already records, per day, exactly the split that
-- matters: what was billed, what was paid against that day, what was paid
-- against OLDER days, the total cash, and the arrears book. It freezes each day
-- so history cannot drift, and stores a `basis` blob recording the cohort rule
-- and sources so a historical figure can still be explained months later.
--
-- Two things stop it being usable.
--
-- 1. NOTHING SCHEDULES IT. A search of cron.job for tppo/period returns no
--    rows. Today's row is written once, early, and then goes stale. Measured
--    this morning:
--
--      snapshot computed at 01:45 EAT  -> total cash 39,000
--      live at 10:38 EAT               -> total cash 563,923
--
--    Fourteen times out. Any screen reading the snapshot for the current day
--    shows last night's numbers.
--
-- 2. AGENT OPS CANNOT READ IT. The single SELECT policy covers tenant_ops,
--    manager, operations, coo, ceo, cfo, cto and super_admin. `agent_ops` is
--    absent, so the team whose dashboard this belongs on reads zero rows.
--
-- WHY A WRAPPER RATHER THAN SCHEDULING tppo_freeze_period DIRECTLY
--
-- Its upsert ends:
--
--      provisional = excluded.provisional,
--      frozen_at   = excluded.frozen_at,
--
-- unconditionally. So calling tppo_freeze_period('day', <a frozen day>, false)
-- sets frozen_at back to NULL and recomputes a settled day. A naive
-- "refresh the last 7 days" job would silently unfreeze a week of finalised
-- history — including 25 September, the day the phantom-billing correction
-- landed, which is now the only record of that 10.4m step.
--
-- The wrapper therefore touches exactly two days and checks before finalising:
--   * today   — always provisional, safe to repeat
--   * yesterday — finalised once, and only if it is not already frozen
--
-- COLLECTIONS ARE NOT AFFECTED
--
-- tppo_freeze_period READS agent_collections, repayments, rent_requests and
-- agent_expected_day_plans, and WRITES to exactly one table:
-- tppo_period_snapshots. Verified by scanning its body for every INSERT/UPDATE/
-- DELETE target. No wallet, no ledger, no collection row is touched, and the
-- only lock taken is on one row of a 44-row table.

-- ---------------------------------------------------------------------------
-- 1. The guarded refresh
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tppo_refresh_daily_snapshot()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today      date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_yesterday  date := (now() AT TIME ZONE 'Africa/Kampala')::date - 1;
  v_today_id   uuid;
  v_final_id   uuid;
  v_frozen     boolean;
BEGIN
  -- Today is always provisional and always safe to recompute.
  v_today_id := public.tppo_freeze_period('day', v_today, false);

  -- Yesterday is finalised exactly once. Checking first is not belt-and-braces:
  -- the upsert assigns frozen_at unconditionally, so a second call with
  -- p_finalise => false would unfreeze it.
  SELECT s.frozen_at IS NOT NULL INTO v_frozen
  FROM public.tppo_period_snapshots s
  WHERE s.granularity = 'day' AND s.period_start = v_yesterday;

  IF v_frozen IS DISTINCT FROM TRUE THEN
    v_final_id := public.tppo_freeze_period('day', v_yesterday, true);
  END IF;

  RETURN jsonb_build_object(
    'as_of', now(),
    'today', v_today,
    'today_refreshed', v_today_id IS NOT NULL,
    'yesterday', v_yesterday,
    'yesterday_finalised_now', v_final_id IS NOT NULL,
    'yesterday_was_already_frozen', COALESCE(v_frozen, false));
END;
$function$;

REVOKE ALL ON FUNCTION public.tppo_refresh_daily_snapshot() FROM public, anon, authenticated;

COMMENT ON FUNCTION public.tppo_refresh_daily_snapshot() IS
  'Cron entry point for the daily collections snapshot. Refreshes today '
  'provisionally and finalises yesterday once. Never touches a frozen day, '
  'because tppo_freeze_period''s upsert assigns frozen_at unconditionally and '
  'would unfreeze settled history. Writes only to tppo_period_snapshots.';

-- ---------------------------------------------------------------------------
-- 2. Let Agent Ops read the series
--
-- The panel this feeds lives on the Agent Ops dashboard, Performance tab.
-- Replaced rather than added to, so there is one policy to read rather than two
-- that have to be mentally OR-ed.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_ops_select_period_snapshots ON public.tppo_period_snapshots;

CREATE POLICY ops_select_period_snapshots
  ON public.tppo_period_snapshots
  FOR SELECT
  USING (
       public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'agent_ops'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

COMMENT ON POLICY ops_select_period_snapshots ON public.tppo_period_snapshots IS
  'Read-only. Adds agent_ops to the original tenant_ops list — the collections '
  'history panel sits on the Agent Ops Performance tab. No write policy exists: '
  'only tppo_freeze_period, which is SECURITY DEFINER, may write here.';

-- ---------------------------------------------------------------------------
-- 3. The schedule
--
-- Registered in production as jobid 41685:
--
--   select cron.schedule('tppo-refresh-daily-snapshot', '*/15 * * * *',
--                        $$ select public.tppo_refresh_daily_snapshot(); $$);
--
-- Every 15 minutes. Today's row stays within a quarter of an hour of the truth,
-- and the first run after midnight Kampala finalises the day that just closed.
-- Collections are bucketed by Kampala date, so nothing can still arrive for a
-- day being finalised at 00:15.
-- ---------------------------------------------------------------------------
