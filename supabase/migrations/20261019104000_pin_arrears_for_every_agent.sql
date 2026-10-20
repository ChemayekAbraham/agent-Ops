-- Daily bill: overdue tenants are billed to every agent, not only idle ones.
--
-- pin_agent_expected_day bills in two passes. Pass 1 pins in-term plans off the
-- schedule. Pass 2 is the arrears fallback: plans past their term end that still
-- owe. Pass 2 carried a guard that only billed those plans to agents who got
-- NOTHING from pass 1:
--
--   and not exists (select 1 from agents_with_bill a
--                   where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id))
--
-- Every agent carrying overdue tenants also carries at least one in-term plan,
-- so in practice the fallback pinned zero rows and the arrears book was never
-- billed. On 2026-10-19 that hid 356 repaying plans worth UGX 6,863,451 of daily
-- expectation across 44 agents — more unbilled plans than the 530 that were
-- billed. An agent collecting from one of those tenants moved nothing on their
-- daily figures, because the tenant had no line on the bill.
--
-- The guard is kept for days before the go-live date. pin_agent_expected_day_catchup
-- re-pins the last 7 days every night (lookback default 6), and without that
-- anchor tonight's run would retro-bill a week of already-reported days and move
-- every historical expected figure. Days before the go-live keep reproducing
-- exactly what they produced before; only the go-live day onward changes.
CREATE OR REPLACE FUNCTION public.agent_arrears_billing_go_live()
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $fn$
  -- First day on which overdue plans are billed to agents who also have in-term
  -- plans. Days before this keep the old "idle agents only" fallback so that the
  -- nightly catchup cannot rewrite history.
  SELECT date '2026-10-19';
$fn$;

REVOKE ALL ON FUNCTION public.agent_arrears_billing_go_live() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_arrears_billing_go_live() TO service_role;

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

  v_old := '      and not exists (
        select 1 from agents_with_bill a
        where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id)
      )';

  v_new := '      and (
        p_day >= public.agent_arrears_billing_go_live()
        or not exists (
          select 1 from agents_with_bill a
          where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id)
        )
      )';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'pin_agent_expected_day: arrears fallback guard not found in the shape this migration expects';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;

-- Backfill the go-live day itself. The bill was already pinned at 00:05 under
-- the old rule, so this only ADDS the rows that rule skipped: every insert is
-- `on conflict (day, rent_request_id) do nothing`, so no pinned row is rewritten
-- and no amount already shown to an agent changes. The catchup call then
-- re-applies existing collections across the days each touched plan now has.
DO $mig$
DECLARE
  v_added int;
  v_result jsonb;
BEGIN
  IF (now() AT TIME ZONE 'Africa/Kampala')::date <> date '2026-10-19' THEN
    RAISE NOTICE 'skipping go-live backfill: today is not 2026-10-19';
    RETURN;
  END IF;

  v_added := public.pin_agent_expected_day(date '2026-10-19');
  v_result := public.pin_agent_expected_day_catchup(0);
  RAISE NOTICE 'go-live backfill: % rows added, catchup %', v_added, v_result;
END
$mig$;
