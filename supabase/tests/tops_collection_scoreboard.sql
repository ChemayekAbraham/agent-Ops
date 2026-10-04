-- Tenant Ops Workspace — tops_collection_scoreboard acceptance test.
-- Self-contained: clones two real rent_requests rows for FK targets, writes
-- agent_expected_day_plans + agent_collections rows directly for a single
-- fixed Kampala day (one overpayer, one non-payer), then calls the RPC while
-- impersonating a real user who holds one of the required roles. Entire
-- script rolls back — nothing here is a permanent write to any real table.
\set ON_ERROR_STOP on
BEGIN;

SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claim.sub', 'b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c', true);

DO $$
DECLARE
  v_rr_source_id uuid;
  v_ac_source_id uuid;
  v_plan_over uuid := gen_random_uuid();
  v_plan_none uuid := gen_random_uuid();
  v_agent_id uuid;
  v_tenant_id uuid;
  v_coll uuid := gen_random_uuid();
  v_board record;
  v_uncapped_coverage numeric;
BEGIN
  SELECT id INTO v_rr_source_id FROM public.rent_requests WHERE status IN ('funded','repaying') LIMIT 1;
  SELECT id INTO v_ac_source_id FROM public.agent_collections LIMIT 1;
  IF v_rr_source_id IS NULL OR v_ac_source_id IS NULL THEN
    RAISE EXCEPTION 'need at least one rent_requests and one agent_collections row to clone for this test';
  END IF;

  SELECT rr.agent_id, rr.tenant_id INTO v_agent_id, v_tenant_id
  FROM public.rent_requests rr WHERE rr.id = v_rr_source_id;

  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_over, 'status', 'repaying'
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_none, 'status', 'repaying'
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  -- Both plans billed 10,000 on the same day.
  INSERT INTO public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  VALUES ('2026-01-15', v_plan_over, v_agent_id, v_tenant_id, 10000);
  INSERT INTO public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  VALUES ('2026-01-15', v_plan_none, v_agent_id, v_tenant_id, 10000);

  -- One plan pays 30,000 against its 10,000 bill (overpayer); the other pays
  -- nothing (non-payer) — no agent_collections row for it at all.
  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(c) || jsonb_build_object(
    'id', v_coll, 'rent_request_id', v_plan_over, 'amount', 30000, 'reversed_at', NULL,
    'created_at', '2026-01-15T10:00:00+03:00'::timestamptz
  ))).* FROM public.agent_collections c WHERE c.id = v_ac_source_id;

  SELECT * INTO v_board FROM public.tops_collection_scoreboard('2026-01-15'::date, '2026-01-15'::date);

  IF v_board.expected_ugx <> 20000 THEN
    RAISE EXCEPTION 'expected expected_ugx 20000, got %', v_board.expected_ugx;
  END IF;
  IF v_board.collected_on_schedule_ugx <> 10000 THEN
    RAISE EXCEPTION 'expected collected_on_schedule_ugx 10000 (capped: 10000 + 0), got %', v_board.collected_on_schedule_ugx;
  END IF;
  IF v_board.collected_arrears_ugx <> 0 THEN
    RAISE EXCEPTION 'expected collected_arrears_ugx 0, got %', v_board.collected_arrears_ugx;
  END IF;
  IF v_board.total_cash_in_ugx <> 30000 THEN
    RAISE EXCEPTION 'expected total_cash_in_ugx 30000, got %', v_board.total_cash_in_ugx;
  END IF;
  IF v_board.coverage_pct <> 50.0 THEN
    RAISE EXCEPTION 'expected capped coverage_pct 50.0, got %', v_board.coverage_pct;
  END IF;

  -- Independently derived uncapped comparator: with no arrears in this
  -- fixture, uncapped on-schedule collected is simply total_cash_in_ugx.
  v_uncapped_coverage := ROUND(100.0 * v_board.total_cash_in_ugx / v_board.expected_ugx, 1);

  IF v_uncapped_coverage <> 150.0 THEN
    RAISE EXCEPTION 'expected uncapped comparator 150.0 (not clamped), got %', v_uncapped_coverage;
  END IF;
  IF NOT (v_board.coverage_pct < v_uncapped_coverage) THEN
    RAISE EXCEPTION 'expected capped coverage (%) to be lower than uncapped (%)', v_board.coverage_pct, v_uncapped_coverage;
  END IF;

  RAISE NOTICE '== one overpayer + one non-payer: capped % < uncapped %, neither clamped: PASS', v_board.coverage_pct, v_uncapped_coverage;
END $$;

ROLLBACK;
