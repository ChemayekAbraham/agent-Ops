-- Tenant Ops Workspace — tops_resolve_plan_clock / tops_build_plan_instalments
-- acceptance test. Self-contained: borrows FK targets (tenant/agent/landlord)
-- from one real rent_requests row and clones it with jsonb_populate_record so
-- every NOT NULL / CHECK constraint on that ~90-column table is satisfied
-- without guessing at valid values by hand. Entire script rolls back — it
-- writes nothing permanent to rent_requests or any tops_* table.
\set ON_ERROR_STOP on
BEGIN;

-- This transaction-local setting (auto-reverts at ROLLBACK, never a lasting
-- change) skips existing rent_requests triggers — e.g. the agent daily
-- collection eligibility gate — while we insert synthetic fixture rows
-- cloned from a real plan. It never disables a trigger on the actual table.
SET LOCAL session_replication_role = replica;

DO $$
DECLARE
  v_source_id uuid;
  v_daily_id uuid := gen_random_uuid();
  v_weekly_id uuid := gen_random_uuid();
  v_unlocked_id uuid := gen_random_uuid();
  v_n integer;
  v_sum numeric;
  v_last numeric;
  v_dow smallint;
BEGIN
  SELECT id INTO v_source_id FROM public.rent_requests
  WHERE status IN ('funded','repaying') LIMIT 1;

  IF v_source_id IS NULL THEN
    RAISE EXCEPTION 'no funded/repaying rent_requests row exists to clone for this test';
  END IF;

  -------------------------------------------------------------------------
  -- 1. Daily plan: 30 instalments, last one absorbs the rounding remainder.
  --    duration_days must satisfy rent_requests_duration_days_check (30/60/
  --    90/120, or a multiple of 7) — 30 is one of the named values.
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_daily_id,
    'duration_days', 30,
    'daily_repayment', 10010,
    'total_repayment', 300202,
    'repayment_frequency', 'daily',
    'repayment_frequency_locked', true,
    'status', 'funded',
    'funded_at', now() - interval '30 days'
  ))).*
  FROM public.rent_requests r WHERE r.id = v_source_id;

  PERFORM public.tops_resolve_plan_clock(v_daily_id);
  v_n := public.tops_build_plan_instalments(v_daily_id);

  IF v_n <> 30 THEN
    RAISE EXCEPTION 'daily plan: expected 30 instalments, got %', v_n;
  END IF;

  SELECT sum(amount_ugx) INTO v_sum FROM public.tops_plan_instalments WHERE rent_request_id = v_daily_id;
  IF v_sum <> 300202 THEN
    RAISE EXCEPTION 'daily plan: expected sum 300202, got %', v_sum;
  END IF;

  SELECT amount_ugx INTO v_last FROM public.tops_plan_instalments WHERE rent_request_id = v_daily_id AND seq = 30;
  IF v_last <> (300202 - 10010 * 29) THEN
    RAISE EXCEPTION 'daily plan: last instalment should absorb the remainder, got %', v_last;
  END IF;

  RAISE NOTICE '== daily plan: PASS (% instalments, sum %)', v_n, v_sum;

  -------------------------------------------------------------------------
  -- 2. Weekly plan: duration_days=90 (one of the named valid values, and not
  --    itself a multiple of 7) -> ceil(90/7) = 13 instalments, the last one
  --    a genuine partial week, weekly_due_dow set, exact sum.
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_weekly_id,
    'duration_days', 90,
    'daily_repayment', 1000,
    'total_repayment', 89950,
    'repayment_frequency', 'weekly',
    'repayment_frequency_locked', true,
    'status', 'funded',
    'funded_at', now() - interval '30 days'
  ))).*
  FROM public.rent_requests r WHERE r.id = v_source_id;

  PERFORM public.tops_resolve_plan_clock(v_weekly_id);
  v_n := public.tops_build_plan_instalments(v_weekly_id);

  IF v_n <> 13 THEN
    RAISE EXCEPTION 'weekly plan: expected 13 instalments (ceil(90/7)), got %', v_n;
  END IF;

  SELECT sum(amount_ugx) INTO v_sum FROM public.tops_plan_instalments WHERE rent_request_id = v_weekly_id;
  IF v_sum <> 89950 THEN
    RAISE EXCEPTION 'weekly plan: expected sum 89950, got %', v_sum;
  END IF;

  SELECT amount_ugx INTO v_last FROM public.tops_plan_instalments WHERE rent_request_id = v_weekly_id AND seq = 13;
  IF v_last <> (89950 - (1000 * 7) * 12) THEN
    RAISE EXCEPTION 'weekly plan: last instalment should absorb the remainder, got %', v_last;
  END IF;

  SELECT weekly_due_dow INTO v_dow FROM public.tops_plan_clock WHERE rent_request_id = v_weekly_id;
  IF v_dow IS NULL THEN
    RAISE EXCEPTION 'weekly plan: weekly_due_dow should be set, got NULL';
  END IF;

  RAISE NOTICE '== weekly plan: PASS (% instalments, sum %, due_dow %)', v_n, v_sum, v_dow;

  -------------------------------------------------------------------------
  -- 3. Unlocked repayment_frequency: cadence resolves to unknown, and
  --    tops_build_plan_instalments writes nothing.
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_unlocked_id,
    'duration_days', 30,
    'daily_repayment', 10000,
    'total_repayment', 300000,
    'repayment_frequency', 'daily',
    'repayment_frequency_locked', false,
    'status', 'funded',
    'funded_at', now() - interval '30 days'
  ))).*
  FROM public.rent_requests r WHERE r.id = v_source_id;

  PERFORM public.tops_resolve_plan_clock(v_unlocked_id);
  v_n := public.tops_build_plan_instalments(v_unlocked_id);

  IF v_n <> 0 THEN
    RAISE EXCEPTION 'unlocked cadence: expected 0 instalments, got %', v_n;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tops_plan_instalments WHERE rent_request_id = v_unlocked_id) THEN
    RAISE EXCEPTION 'unlocked cadence: expected zero tops_plan_instalments rows to be written';
  END IF;

  IF (SELECT cadence FROM public.tops_plan_clock WHERE rent_request_id = v_unlocked_id) <> 'unknown' THEN
    RAISE EXCEPTION 'unlocked cadence: expected tops_plan_clock.cadence = unknown';
  END IF;

  RAISE NOTICE '== unlocked/unknown cadence: PASS (0 instalments written)';
END $$;

ROLLBACK;
