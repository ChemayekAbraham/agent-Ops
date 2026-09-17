-- Arrears: fix the "phantom 1 day behind" false positive.
--
-- ROOT CAUSE (see docs/HANDOVER for the write-up)
-- `v_rent_plan_schedule` gates a plan on landlord-payout evidence
-- (`le.paid_out > 0 OR le.open_allocs = 0 OR amount_repaid > 0 OR no evidence
-- row`). That gate is evaluated live, at the instant the
-- `pin-agent-expected-day-eat-midnight` cron runs (00:05 EAT). A plan funded
-- late enough that the landlord payout clears AFTER that midnight pin but
-- BEFORE the tenant's first payment fails the gate at pin time, so its very
-- first billed day is silently never pinned into `agent_expected_day_plans`.
--
-- There is no retry for a missed day — the cron only ever pins "today". The
-- day only gets backfilled if some unrelated caller (e.g.
-- `get_agent_collections_command_center`, when a report happens to query a
-- range covering it) opportunistically re-pins that historical date. By then
-- the tenant's real day-1 collection has already been swept by
-- `rent_apply_collections_to_days` against whatever day DID exist at sweep
-- time (day 2), because day 1 didn't exist yet to claim it. When day 1 is
-- finally backfilled, there is no unapplied money left to give it — the old
-- allocator only ever moved UNAPPLIED funds onto open days, it never pulled
-- money back off an already-settled later day. Day 1 sits open forever: a
-- permanent phantom "1 day behind" despite the tenant having paid in full.
--
-- Confirmed on two live plans (Faizal Kayondo, Hamiss Mutyaba under agent
-- Shakirah Nakimbugwe): 100% of billed days collected, in full, on schedule
-- — yet both showed arrears exactly equal to their first day's rent.
--
-- THE FIX (two parts, neither of which changes what any tenant owes)
--
-- 1. `pin_agent_expected_day_for_plan(rent_request_id)` — a per-plan catch-up
--    that backfills any day from the plan's term_start to today that the
--    gate now allows but previously didn't. Idempotent (ON CONFLICT DO
--    NOTHING), cheap (scoped to one plan, not a full-table scan).
--
-- 2. `rent_apply_collections_to_days(rent_request_id)` now (a) runs that
--    catch-up first, then (b) fully re-derives the plan's settlement rows
--    from ALL of its collections against ALL of its pinned days (delete +
--    rebuild), instead of only ever moving money that was still
--    "unapplied". This is what lets a late-arriving day-1 pull money back
--    from whichever later day absorbed it — a real rebalance, not just an
--    incremental top-up. The total attributed never changes, only which day
--    it's counted against.
--
-- `pin_agent_expected_day_catchup()` replaces the nightly cron target: it
-- pins a trailing week (catching any plan whose gate clears with no further
-- collection to trigger the fix above) and rebalances every plan that still
-- has an open day in that window. This is the backstop for plans that never
-- get another collection after the missed day.

-- --------------------------------------------------------- per-plan catch-up

CREATE OR REPLACE FUNCTION public.pin_agent_expected_day_for_plan(p_rent_request_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_term_start date;
  v_rows int := 0;
BEGIN
  IF p_rent_request_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT s.term_start INTO v_term_start
  FROM public.v_rent_plan_schedule s
  WHERE s.rent_request_id = p_rent_request_id;

  -- Plan still fails the schedule gate (landlord payout still open, no
  -- tenant payment yet) — correctly nothing to backfill until that clears.
  IF v_term_start IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  SELECT g.due_on, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  FROM public.rent_plan_schedule_days(v_term_start, v_today) g
  JOIN public.v_rent_plan_schedule s ON s.rent_request_id = g.rent_request_id
  WHERE g.rent_request_id = p_rent_request_id
  ON CONFLICT (day, rent_request_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

COMMENT ON FUNCTION public.pin_agent_expected_day_for_plan(uuid) IS
  'Backfills any day from a single plan''s term_start to today that the v_rent_plan_schedule gate now allows but did not at the time of the nightly pin (e.g. landlord payout that cleared after 00:05 EAT). Scoped to one plan so it is cheap to call from the collection path.';

REVOKE ALL ON FUNCTION public.pin_agent_expected_day_for_plan(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_agent_expected_day_for_plan(uuid) TO service_role;

-- --------------------------------------------------- the allocator, rebuilt

CREATE OR REPLACE FUNCTION public.rent_apply_collections_to_days(p_rent_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows int := 0;
  v_amount numeric := 0;
  v_backfilled int := 0;
BEGIN
  IF p_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_plan');
  END IF;

  -- Serialise per plan so two concurrent collections cannot both claim the
  -- same open day. Plan-scoped, so it never blocks other agents.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_rent_request_id::text, 0));

  -- Catch up any day the schedule gate has since cleared for (this is what a
  -- missed day-1 needs) BEFORE computing the waterfall, so the ledger below
  -- reflects the plan's true bill.
  v_backfilled := public.pin_agent_expected_day_for_plan(p_rent_request_id);

  -- Full re-derive rather than "apply only unapplied money onto open days":
  -- if a day was ever pinned late, money already attributed to a later day
  -- has to be able to move back onto it. Wiping and rebuilding this plan's
  -- settlement rows from ALL its collections against ALL its pinned days is
  -- what makes that possible; it changes only which day money is counted
  -- against, never the total attributed (still capped at collected vs
  -- billed) and never `total_repayment - amount_repaid`.
  DELETE FROM public.rent_day_settlements WHERE rent_request_id = p_rent_request_id;

  WITH funds AS (
    SELECT ac.id AS collection_id,
           ac.amount AS unapplied_ugx,
           COALESCE(SUM(ac.amount) OVER (ORDER BY ac.created_at, ac.id
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS f_start
    FROM public.agent_collections ac
    WHERE ac.rent_request_id = p_rent_request_id
      AND ac.amount > 0
      AND COALESCE(ac.notes, '') NOT ILIKE '%[REVERSED:%'
  ), open_days AS (
    SELECT ep.day,
           ep.expected_ugx AS remaining_ugx,
           COALESCE(SUM(ep.expected_ugx) OVER (ORDER BY ep.day
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS d_start
    FROM public.agent_expected_day_plans ep
    WHERE ep.rent_request_id = p_rent_request_id
  ), matched AS (
    SELECT d.day,
           f.collection_id,
           LEAST(f.f_start + f.unapplied_ugx, d.d_start + d.remaining_ugx)
             - GREATEST(f.f_start, d.d_start) AS amount
    FROM funds f
    JOIN open_days d
      ON LEAST(f.f_start + f.unapplied_ugx, d.d_start + d.remaining_ugx)
         > GREATEST(f.f_start, d.d_start)
  ), ins AS (
    INSERT INTO public.rent_day_settlements (rent_request_id, day, collection_id, amount)
    SELECT p_rent_request_id, m.day, m.collection_id, m.amount
    FROM matched m
    WHERE m.amount > 0
    ON CONFLICT (collection_id, day)
      DO UPDATE SET amount = EXCLUDED.amount
    RETURNING amount
  )
  SELECT count(*)::int, COALESCE(SUM(amount), 0) INTO v_rows, v_amount FROM ins;

  RETURN jsonb_build_object(
    'status', 'applied',
    'rent_request_id', p_rent_request_id,
    'rows', v_rows,
    'amount_applied', v_amount,
    'days_backfilled', v_backfilled
  );
END;
$function$;

COMMENT ON FUNCTION public.rent_apply_collections_to_days(uuid) IS
  'Backfills any newly-eligible pinned day for this plan, then fully re-derives its rent_day_settlements from every collection against every pinned day, oldest day and oldest money first. Idempotent and safe to re-run: total attributed never changes, only which day it is counted against. Call after a collection and after the daily pin.';

-- ---------------------------------------------------------- nightly catch-up

-- Replaces "pin today only" as the cron target. Backstops plans that missed
-- their day-1 pin AND never get another collection to trigger the rebalance
-- above (e.g. a plan paid off in one shot before the gate cleared).
CREATE OR REPLACE FUNCTION public.pin_agent_expected_day_catchup(p_lookback_days integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_pinned int := 0;
  v_plans int := 0;
  d date;
  r record;
BEGIN
  FOR d IN SELECT generate_series(v_today - GREATEST(p_lookback_days, 0), v_today, interval '1 day')::date LOOP
    v_pinned := v_pinned + COALESCE(public.pin_agent_expected_day(d), 0);
  END LOOP;

  -- Any plan with an open day inside the lookback window gets rebalanced.
  -- Harmless no-op for plans that are genuinely behind; this is what repairs
  -- a plan whose day-1 (or any day) just got backfilled above.
  FOR r IN
    SELECT DISTINCT l.rent_request_id
    FROM public.v_rent_day_ledger l
    WHERE l.day BETWEEN v_today - GREATEST(p_lookback_days, 0) AND v_today
      AND l.remaining_ugx > 0
  LOOP
    PERFORM public.rent_apply_collections_to_days(r.rent_request_id);
    v_plans := v_plans + 1;
  END LOOP;

  RETURN jsonb_build_object('status', 'ok', 'as_of', v_today,
                            'days_pinned', v_pinned, 'plans_rebalanced', v_plans);
END;
$function$;

COMMENT ON FUNCTION public.pin_agent_expected_day_catchup(integer) IS
  'Nightly cron target. Pins today plus a trailing lookback window (catching any plan whose schedule gate cleared late), then rebalances every plan with an open day in that window. Backstop for plans that miss their day-1 pin and get no further collection to trigger rent_apply_collections_to_days directly.';

REVOKE ALL ON FUNCTION public.pin_agent_expected_day_catchup(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_agent_expected_day_catchup(integer) TO service_role;

-- Point the existing cron job at the catch-up wrapper instead of a bare
-- "pin today". Job id / schedule unchanged (still 00:05 EAT).
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'pin-agent-expected-day-eat-midnight'),
  command := 'SELECT public.pin_agent_expected_day_catchup();'
);

-- One-time repair of every plan already affected by the gap (bounded by the
-- 2026-09-10 arrears go-live floor, so a 30-day window is comfortably wide).
SELECT public.pin_agent_expected_day_catchup(30);
