-- Tenant Ops Workspace — tops_allocate_collection acceptance test.
-- Self-contained: clones a real rent_requests row and a real agent_collections
-- row (via jsonb_populate_record, so every NOT NULL/CHECK/enum constraint on
-- either ~30-90 column table is satisfied without guessing values by hand),
-- builds each synthetic plan's own instalment schedule, then exercises the
-- allocation engine against pure fixture data. Entire script rolls back — it
-- writes nothing permanent to agent_collections, rent_requests or any tops_*
-- table.
\set ON_ERROR_STOP on
BEGIN;

SET LOCAL session_replication_role = replica;

DO $$
DECLARE
  v_rr_source_id uuid;
  v_ac_source_id uuid;
  v_plan_a uuid := gen_random_uuid();
  v_plan_b uuid := gen_random_uuid();
  v_plan_c uuid := gen_random_uuid();
  v_coll_1 uuid := gen_random_uuid();
  v_coll_2 uuid := gen_random_uuid();
  v_coll_3 uuid := gen_random_uuid();
  v_n integer;
  v_touched integer;
  v_amt numeric;
  v_seq1_id uuid;
  v_seq1_amt_before numeric;
BEGIN
  SELECT id INTO v_rr_source_id FROM public.rent_requests WHERE status IN ('funded','repaying') LIMIT 1;
  SELECT id INTO v_ac_source_id FROM public.agent_collections LIMIT 1;

  IF v_rr_source_id IS NULL OR v_ac_source_id IS NULL THEN
    RAISE EXCEPTION 'need at least one rent_requests and one agent_collections row to clone for this test';
  END IF;

  -------------------------------------------------------------------------
  -- Build three identical 30-day, 10000/day plans (total 300000, no
  -- rounding remainder) to keep the arithmetic in each scenario obvious.
  -------------------------------------------------------------------------
  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_a, 'duration_days', 30, 'daily_repayment', 10000, 'total_repayment', 300000,
    'repayment_frequency', 'daily', 'repayment_frequency_locked', true, 'status', 'funded',
    'funded_at', now() - interval '60 days'
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_b, 'duration_days', 30, 'daily_repayment', 10000, 'total_repayment', 300000,
    'repayment_frequency', 'daily', 'repayment_frequency_locked', true, 'status', 'funded',
    'funded_at', now() - interval '60 days'
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  INSERT INTO public.rent_requests
  SELECT (jsonb_populate_record(NULL::public.rent_requests, to_jsonb(r) || jsonb_build_object(
    'id', v_plan_c, 'duration_days', 30, 'daily_repayment', 10000, 'total_repayment', 300000,
    'repayment_frequency', 'daily', 'repayment_frequency_locked', true, 'status', 'funded',
    'funded_at', now() - interval '60 days'
  ))).* FROM public.rent_requests r WHERE r.id = v_rr_source_id;

  PERFORM public.tops_resolve_plan_clock(v_plan_a);
  PERFORM public.tops_build_plan_instalments(v_plan_a);
  PERFORM public.tops_resolve_plan_clock(v_plan_b);
  PERFORM public.tops_build_plan_instalments(v_plan_b);
  PERFORM public.tops_resolve_plan_clock(v_plan_c);
  PERFORM public.tops_build_plan_instalments(v_plan_c);

  -------------------------------------------------------------------------
  -- 1. Partial payment: settles the oldest instalment only, partially, and
  --    never touches the next one.
  -------------------------------------------------------------------------
  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(c) || jsonb_build_object(
    'id', v_coll_1, 'rent_request_id', v_plan_a, 'amount', 6000, 'reversed_at', NULL,
    'created_at', now() - interval '10 days'
  ))).* FROM public.agent_collections c WHERE c.id = v_ac_source_id;

  v_touched := public.tops_allocate_collection(v_coll_1);

  IF v_touched <> 1 THEN
    RAISE EXCEPTION 'partial payment: expected 1 instalment touched, got %', v_touched;
  END IF;

  SELECT s.amount_ugx INTO v_amt
  FROM public.tops_instalment_settlements s
  JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
  WHERE s.collection_id = v_coll_1 AND i.seq = 1;
  IF v_amt <> 6000 THEN
    RAISE EXCEPTION 'partial payment: expected seq 1 settled 6000, got %', v_amt;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tops_instalment_settlements s
    JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
    WHERE s.collection_id = v_coll_1 AND i.seq > 1
  ) THEN
    RAISE EXCEPTION 'partial payment: should not have touched any instalment past seq 1';
  END IF;

  RAISE NOTICE '== partial payment settles oldest day first: PASS';

  -------------------------------------------------------------------------
  -- 4. Double-run: rerunning the same collection changes nothing (same row
  --    id, same amount).
  -------------------------------------------------------------------------
  SELECT s.id, s.amount_ugx INTO v_seq1_id, v_seq1_amt_before
  FROM public.tops_instalment_settlements s
  JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
  WHERE s.collection_id = v_coll_1 AND i.seq = 1;

  v_touched := public.tops_allocate_collection(v_coll_1);

  IF v_touched <> 1 THEN
    RAISE EXCEPTION 'double-run: expected 1 instalment touched again, got %', v_touched;
  END IF;

  IF (SELECT count(*) FROM public.tops_instalment_settlements WHERE collection_id = v_coll_1) <> 1 THEN
    RAISE EXCEPTION 'double-run: expected exactly 1 settlement row for this collection after rerun';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tops_instalment_settlements
    WHERE id = v_seq1_id AND amount_ugx = v_seq1_amt_before
  ) THEN
    RAISE EXCEPTION 'double-run: settlement row id/amount should be unchanged by a rerun';
  END IF;

  RAISE NOTICE '== double-run produces identical rows: PASS';

  -------------------------------------------------------------------------
  -- 2. Overpayment: a single large collection runs forward across many
  --    instalments in order.
  -------------------------------------------------------------------------
  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(c) || jsonb_build_object(
    'id', v_coll_2, 'rent_request_id', v_plan_b, 'amount', 235000, 'reversed_at', NULL,
    'created_at', now() - interval '10 days'
  ))).* FROM public.agent_collections c WHERE c.id = v_ac_source_id;

  v_touched := public.tops_allocate_collection(v_coll_2);

  IF v_touched <> 24 THEN
    RAISE EXCEPTION 'overpayment: expected 24 instalments touched (23 full + 1 partial), got %', v_touched;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tops_instalment_settlements s
    JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
    WHERE s.collection_id = v_coll_2 AND i.seq <= 23 AND s.amount_ugx <> 10000
  ) THEN
    RAISE EXCEPTION 'overpayment: instalments 1..23 should each be fully settled at 10000';
  END IF;

  SELECT s.amount_ugx INTO v_amt
  FROM public.tops_instalment_settlements s
  JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
  WHERE s.collection_id = v_coll_2 AND i.seq = 24;
  IF v_amt <> 5000 THEN
    RAISE EXCEPTION 'overpayment: expected seq 24 settled 5000 (the running-forward remainder), got %', v_amt;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tops_instalment_settlements s
    JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
    WHERE s.collection_id = v_coll_2 AND i.seq > 24
  ) THEN
    RAISE EXCEPTION 'overpayment: should not have touched any instalment past seq 24';
  END IF;

  RAISE NOTICE '== overpayment runs forward: PASS';

  -------------------------------------------------------------------------
  -- 3. Reversal: releases the settlement instead of allocating.
  -------------------------------------------------------------------------
  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(c) || jsonb_build_object(
    'id', v_coll_3, 'rent_request_id', v_plan_c, 'amount', 10000, 'reversed_at', NULL,
    'created_at', now() - interval '10 days'
  ))).* FROM public.agent_collections c WHERE c.id = v_ac_source_id;

  v_touched := public.tops_allocate_collection(v_coll_3);
  IF v_touched <> 1 THEN
    RAISE EXCEPTION 'reversal fixture: expected the initial allocation to touch 1 instalment, got %', v_touched;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tops_instalment_settlements
    WHERE collection_id = v_coll_3 AND released_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'reversal fixture: settlement should not be released before the collection is reversed';
  END IF;

  UPDATE public.agent_collections SET reversed_at = now() WHERE id = v_coll_3;

  v_touched := public.tops_allocate_collection(v_coll_3);
  IF v_touched <> 1 THEN
    RAISE EXCEPTION 'reversal: expected 1 settlement released, got %', v_touched;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tops_instalment_settlements
    WHERE collection_id = v_coll_3 AND released_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'reversal: settlement should now be released';
  END IF;

  RAISE NOTICE '== reversal releases settlements: PASS';
END $$;

ROLLBACK;
