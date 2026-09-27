-- Tenant Ops Workspace — tops_plan_position / tops_plan_schedule_ledger
-- acceptance test. Self-contained: clones a real rent_requests row and a
-- real agent_collections row per fixture, writes tops_plan_clock rows
-- directly (bypassing tops_resolve_plan_clock's now()/funded_at dependency)
-- so every scenario's clock_start and as_at are exact, fixed dates rather
-- than dependent on when this script happens to run. Impersonates a real
-- user who holds one of the required roles (operations/coo/...) via
-- request.jwt.claim.sub, so the functions' internal has_role gate passes.
-- Entire script rolls back — nothing written here is permanent.
\set ON_ERROR_STOP on
BEGIN;

SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claim.sub', 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c', true);

DO $$
DECLARE
  v_rr_source_id uuid;
  v_ac_source_id uuid;
  v_plan_behind uuid := gen_random_uuid();
  v_plan_weekly uuid := gen_random_uuid();
  v_plan_ahead uuid := gen_random_uuid();
  v_plan_expired uuid := gen_random_uuid();
  v_coll_a uuid := gen_random_uuid();
  v_coll_b uuid := gen_random_uuid();
  v_coll_c uuid := gen_random_uuid();
  v_pos record;
  v_seq1_id uuid;
  v_seq4_id uuid;
  v_touched integer;
  v_ledger_row record;
  v_ledger_count integer := 0;
BEGIN
  SELECT id INTO v_rr_source_id FROM public.rent_requests WHERE status IN ('funded','repaying') LIMIT 1;
  SELECT id INTO v_ac_source_id FROM public.agent_collections LIMIT 1;
  IF v_rr_source_id IS NULL OR v_ac_source_id IS NULL THEN
    RAISE EXCEPTION 'need at least one rent_requests and one agent_collections row to clone for this test';
  END IF;

  -------------------------------------------------------------------------
  -- 1. Daily plan, behind: clock_start 2026-01-01, as_at 2026-01-11
  --    (10 days elapsed, nothing paid).
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_behind, 'duration_days', 30, 'daily_repayment', 10000, 'total_repayment', 300000,
    'repayment_frequency', 'daily', 'repayment_frequency_locked', true, 'status', 'funded',
    'funded_at', '2026-01-01T06:00:00+03:00'::timestamptz
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  INSERT INTO public.tops_plan_clock (rent_request_id, clock_start, clock_source, cadence, cadence_source)
  VALUES (v_plan_behind, '2026-01-01', 'funded_at', 'daily', 'explicit');

  PERFORM public.tops_build_plan_instalments(v_plan_behind);

  SELECT * INTO v_pos FROM public.tops_plan_position(v_plan_behind, '2026-01-11'::date);

  IF v_pos.periods_due <> 10 THEN RAISE EXCEPTION 'behind: expected periods_due 10, got %', v_pos.periods_due; END IF;
  IF v_pos.days_past_due <> 9 THEN RAISE EXCEPTION 'behind: expected days_past_due 9, got %', v_pos.days_past_due; END IF;
  IF v_pos.expected_to_date_ugx <> 100000 THEN RAISE EXCEPTION 'behind: expected expected_to_date_ugx 100000, got %', v_pos.expected_to_date_ugx; END IF;
  IF v_pos.paid_to_date_ugx <> 0 THEN RAISE EXCEPTION 'behind: expected paid_to_date_ugx 0, got %', v_pos.paid_to_date_ugx; END IF;
  IF v_pos.position_ugx <> -100000 THEN RAISE EXCEPTION 'behind: expected position_ugx -100000, got %', v_pos.position_ugx; END IF;
  IF v_pos.days_behind <> 10 THEN RAISE EXCEPTION 'behind: expected days_behind 10, got %', v_pos.days_behind; END IF;
  IF v_pos.days_ahead <> 0 THEN RAISE EXCEPTION 'behind: expected days_ahead 0, got %', v_pos.days_ahead; END IF;
  IF v_pos.outstanding_ugx <> 300000 THEN RAISE EXCEPTION 'behind: expected outstanding_ugx 300000, got %', v_pos.outstanding_ugx; END IF;
  IF v_pos.term_expired IS NOT FALSE THEN RAISE EXCEPTION 'behind: expected term_expired false, got %', v_pos.term_expired; END IF;
  IF v_pos.catch_up_daily_ugx <> 15000 THEN RAISE EXCEPTION 'behind: expected catch_up_daily_ugx 15000, got %', v_pos.catch_up_daily_ugx; END IF;

  RAISE NOTICE '== daily plan behind: PASS';

  -------------------------------------------------------------------------
  -- 2. Weekly plan, two missed due dates: seq1 (due 01-08) and seq4
  --    (due 01-29, = as_at) are paid; seq2 (due 01-15) and seq3 (due 01-22)
  --    are not. Expect periods_due 2, days_past_due 14.
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_weekly, 'duration_days', 90, 'daily_repayment', 1000, 'total_repayment', 90000,
    'repayment_frequency', 'weekly', 'repayment_frequency_locked', true, 'status', 'funded',
    'funded_at', '2026-01-01T06:00:00+03:00'::timestamptz
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  INSERT INTO public.tops_plan_clock (rent_request_id, clock_start, clock_source, cadence, cadence_source, weekly_due_dow)
  VALUES (v_plan_weekly, '2026-01-01', 'funded_at', 'weekly', 'explicit', EXTRACT(DOW FROM DATE '2026-01-01')::smallint);

  PERFORM public.tops_build_plan_instalments(v_plan_weekly);

  SELECT id INTO v_seq1_id FROM public.tops_plan_instalments WHERE rent_request_id = v_plan_weekly AND seq = 1;
  SELECT id INTO v_seq4_id FROM public.tops_plan_instalments WHERE rent_request_id = v_plan_weekly AND seq = 4;

  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(c) || jsonb_build_object(
    'id', v_coll_a, 'rent_request_id', v_plan_weekly, 'amount', 7000, 'reversed_at', NULL,
    'created_at', '2026-01-08T06:00:00+03:00'::timestamptz
  ))).* FROM public.agent_collections c WHERE c.id = v_ac_source_id;

  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(c) || jsonb_build_object(
    'id', v_coll_b, 'rent_request_id', v_plan_weekly, 'amount', 7000, 'reversed_at', NULL,
    'created_at', '2026-01-29T06:00:00+03:00'::timestamptz
  ))).* FROM public.agent_collections c WHERE c.id = v_ac_source_id;

  -- Direct settlement inserts (not via tops_allocate_collection): this is a
  -- deliberately out-of-order fixture (this week's payment made while two
  -- older weeks sit unpaid), which the oldest-first allocator would never
  -- itself produce — exactly the state we need to exercise the reader.
  INSERT INTO public.tops_instalment_settlements (instalment_id, collection_id, rent_request_id, amount_ugx)
  VALUES (v_seq1_id, v_coll_a, v_plan_weekly, 7000);
  INSERT INTO public.tops_instalment_settlements (instalment_id, collection_id, rent_request_id, amount_ugx)
  VALUES (v_seq4_id, v_coll_b, v_plan_weekly, 7000);

  SELECT * INTO v_pos FROM public.tops_plan_position(v_plan_weekly, '2026-01-29'::date);

  IF v_pos.periods_due <> 2 THEN RAISE EXCEPTION 'weekly: expected periods_due 2, got %', v_pos.periods_due; END IF;
  IF v_pos.days_past_due <> 14 THEN RAISE EXCEPTION 'weekly: expected days_past_due 14, got %', v_pos.days_past_due; END IF;

  RAISE NOTICE '== weekly plan, two missed due dates: PASS (periods_due %, days_past_due %)', v_pos.periods_due, v_pos.days_past_due;

  -- Light sanity check on the ledger companion RPC for this same plan.
  FOR v_ledger_row IN SELECT * FROM public.tops_plan_schedule_ledger(v_plan_weekly) LOOP
    v_ledger_count := v_ledger_count + 1;
    IF v_ledger_row.seq = 2 AND v_ledger_row.outstanding_ugx <> 7000 THEN
      RAISE EXCEPTION 'ledger: expected seq 2 outstanding 7000, got %', v_ledger_row.outstanding_ugx;
    END IF;
    IF v_ledger_row.seq = 1 AND v_ledger_row.outstanding_ugx <> 0 THEN
      RAISE EXCEPTION 'ledger: expected seq 1 outstanding 0 (settled), got %', v_ledger_row.outstanding_ugx;
    END IF;
  END LOOP;
  IF v_ledger_count <> 13 THEN RAISE EXCEPTION 'ledger: expected 13 rows (ceil(90/7)), got %', v_ledger_count; END IF;

  RAISE NOTICE '== schedule ledger sanity check: PASS';

  -------------------------------------------------------------------------
  -- 3. Daily plan, ahead: 8 instalments (80000) fully paid by day 5
  --    (only 5 were due).
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_ahead, 'duration_days', 30, 'daily_repayment', 10000, 'total_repayment', 300000,
    'repayment_frequency', 'daily', 'repayment_frequency_locked', true, 'status', 'funded',
    'funded_at', '2026-01-01T06:00:00+03:00'::timestamptz
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  INSERT INTO public.tops_plan_clock (rent_request_id, clock_start, clock_source, cadence, cadence_source)
  VALUES (v_plan_ahead, '2026-01-01', 'funded_at', 'daily', 'explicit');

  PERFORM public.tops_build_plan_instalments(v_plan_ahead);

  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(c) || jsonb_build_object(
    'id', v_coll_c, 'rent_request_id', v_plan_ahead, 'amount', 80000, 'reversed_at', NULL,
    'created_at', '2026-01-05T06:00:00+03:00'::timestamptz
  ))).* FROM public.agent_collections c WHERE c.id = v_ac_source_id;

  v_touched := public.tops_allocate_collection(v_coll_c);
  IF v_touched <> 8 THEN RAISE EXCEPTION 'ahead: expected 8 instalments settled, got %', v_touched; END IF;

  SELECT * INTO v_pos FROM public.tops_plan_position(v_plan_ahead, '2026-01-06'::date);

  IF v_pos.periods_due <> 0 THEN RAISE EXCEPTION 'ahead: expected periods_due 0, got %', v_pos.periods_due; END IF;
  IF v_pos.days_past_due <> 0 THEN RAISE EXCEPTION 'ahead: expected days_past_due 0, got %', v_pos.days_past_due; END IF;
  IF v_pos.expected_to_date_ugx <> 50000 THEN RAISE EXCEPTION 'ahead: expected expected_to_date_ugx 50000, got %', v_pos.expected_to_date_ugx; END IF;
  IF v_pos.paid_to_date_ugx <> 80000 THEN RAISE EXCEPTION 'ahead: expected paid_to_date_ugx 80000, got %', v_pos.paid_to_date_ugx; END IF;
  IF v_pos.position_ugx <> 30000 THEN RAISE EXCEPTION 'ahead: expected position_ugx 30000, got %', v_pos.position_ugx; END IF;
  IF v_pos.days_behind <> 0 THEN RAISE EXCEPTION 'ahead: expected days_behind 0, got %', v_pos.days_behind; END IF;
  IF v_pos.days_ahead <> 3 THEN RAISE EXCEPTION 'ahead: expected days_ahead 3, got %', v_pos.days_ahead; END IF;
  IF v_pos.term_expired IS NOT FALSE THEN RAISE EXCEPTION 'ahead: expected term_expired false, got %', v_pos.term_expired; END IF;

  RAISE NOTICE '== daily plan ahead: PASS';

  -------------------------------------------------------------------------
  -- 4. Expired term: as_at well past term_end_date.
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_expired, 'duration_days', 30, 'daily_repayment', 10000, 'total_repayment', 300000,
    'repayment_frequency', 'daily', 'repayment_frequency_locked', true, 'status', 'funded',
    'funded_at', '2026-01-01T06:00:00+03:00'::timestamptz
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  INSERT INTO public.tops_plan_clock (rent_request_id, clock_start, clock_source, cadence, cadence_source)
  VALUES (v_plan_expired, '2026-01-01', 'funded_at', 'daily', 'explicit');

  PERFORM public.tops_build_plan_instalments(v_plan_expired);

  SELECT * INTO v_pos FROM public.tops_plan_position(v_plan_expired, '2026-03-01'::date);

  IF v_pos.term_expired IS NOT TRUE THEN RAISE EXCEPTION 'expired: expected term_expired true, got %', v_pos.term_expired; END IF;
  IF v_pos.catch_up_daily_ugx IS NOT NULL THEN RAISE EXCEPTION 'expired: expected catch_up_daily_ugx null, got %', v_pos.catch_up_daily_ugx; END IF;
  IF v_pos.term_end_date <> '2026-01-30' THEN RAISE EXCEPTION 'expired: expected term_end_date 2026-01-30, got %', v_pos.term_end_date; END IF;
  IF v_pos.expected_to_date_ugx <> 300000 THEN RAISE EXCEPTION 'expired: expected expected_to_date_ugx capped at 300000, got %', v_pos.expected_to_date_ugx; END IF;

  RAISE NOTICE '== expired term: PASS';
END $$;

ROLLBACK;
