-- Tenant Ops Workspace — tops_detect_collection_anomalies acceptance test.
-- Self-contained: clones one real agent_collections row and one real
-- general_ledger float-leg row (jsonb_populate_record, same technique as
-- tops_plan_clock_and_instalments.sql) so every NOT NULL/CHECK constraint on
-- either table is satisfied without guessing at valid values by hand, then
-- deliberately inverts the cloned ledger leg's direction. Entire script
-- rolls back — it writes nothing permanent to agent_collections,
-- general_ledger, or any tops_* table.
\set ON_ERROR_STOP on
BEGIN;

-- Transaction-local only (auto-reverts at ROLLBACK): skips triggers on
-- agent_collections/general_ledger while inserting synthetic fixture rows
-- cloned from real ones. Never disables a trigger on the actual tables.
SET LOCAL session_replication_role = replica;

DO $$
DECLARE
  v_source_collection agent_collections%ROWTYPE;
  v_source_leg general_ledger%ROWTYPE;
  v_test_collection_id uuid := gen_random_uuid();
  v_test_rent_request_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_anomaly_count integer;
  v_detected integer;
BEGIN
  -- A real, clean agent_float collection to clone the row shape from.
  SELECT * INTO v_source_collection
  FROM public.agent_collections
  WHERE collection_channel = 'agent_float' AND reversed_at IS NULL
  ORDER BY created_at DESC LIMIT 1;
  IF v_source_collection.id IS NULL THEN
    RAISE EXCEPTION 'no clean agent_float collection exists to clone for this test';
  END IF;

  -- A real float leg (correct direction, cash_out) to clone the ledger row
  -- shape from, so nothing about its own required columns is guessed.
  SELECT * INTO v_source_leg
  FROM public.general_ledger
  WHERE source_table = 'agent_collections'
    AND classification = 'production'
    AND wallet_bucket = 'float'
    AND category = 'agent_float_used_for_rent'
    AND direction = 'cash_out'
  ORDER BY created_at DESC LIMIT 1;
  IF v_source_leg.id IS NULL THEN
    RAISE EXCEPTION 'no clean agent_float float leg exists to clone for this test';
  END IF;

  -- Make sure a known expectation row exists for this channel (real seeded
  -- data should already have one, but the test does not depend on that
  -- having been run first).
  INSERT INTO public.tops_collection_expectations
    (collection_channel, expected_float_direction, expected_float_sign,
     float_ratio_min, float_ratio_max, commission_ratio_min, commission_ratio_max, sample_size, seeded_from, seeded_to)
  VALUES ('agent_float', 'cash_out', -1, 0.99, 1.01, 0.09, 0.11, 1, v_now, v_now)
  ON CONFLICT (collection_channel) DO NOTHING;

  -- Clone the collection, overriding only what makes it our synthetic,
  -- traceable fixture row.
  INSERT INTO public.agent_collections
  SELECT (jsonb_populate_record(NULL::public.agent_collections, to_jsonb(v_source_collection) || jsonb_build_object(
    'id', v_test_collection_id,
    'rent_request_id', v_test_rent_request_id,
    'created_at', v_now,
    'reversed_at', NULL,
    'client_ref', NULL,
    'tracking_id', NULL,
    'idempotency_key', NULL,
    'notes', 'SQL test fixture — tops_collection_anomaly_detection.sql, rolled back'
  ))).*;

  -- Clone the float leg, but INVERT its direction — the deliberately
  -- inverted synthetic case the brief asks for.
  INSERT INTO public.general_ledger
  SELECT (jsonb_populate_record(NULL::public.general_ledger, to_jsonb(v_source_leg) || jsonb_build_object(
    'id', gen_random_uuid(),
    'source_id', v_test_rent_request_id,
    'created_at', v_now,
    'transaction_date', v_now,
    'user_id', v_source_collection.agent_id,
    'amount', v_source_collection.amount,
    'direction', 'cash_in',  -- inverted: expectation for this channel is cash_out
    'idempotency_key', NULL
  ))).*;

  PERFORM public.tops_detect_collection_anomalies(v_now - interval '1 minute');

  SELECT count(*) INTO v_anomaly_count
  FROM public.tops_collection_anomalies
  WHERE collection_id = v_test_collection_id AND rule_fired = 'float_direction_inverted' AND severity = 'critical';

  IF v_anomaly_count <> 1 THEN
    RAISE EXCEPTION 'detector did not fire on the deliberately inverted synthetic collection (found % rows)', v_anomaly_count;
  END IF;

  -- Idempotency: a second scan over the same window must not duplicate it.
  SELECT public.tops_detect_collection_anomalies(v_now - interval '1 minute') INTO v_detected;
  SELECT count(*) INTO v_anomaly_count
  FROM public.tops_collection_anomalies
  WHERE collection_id = v_test_collection_id AND rule_fired = 'float_direction_inverted';
  IF v_anomaly_count <> 1 THEN
    RAISE EXCEPTION 'detector duplicated a finding on a second scan of the same window (found % rows)', v_anomaly_count;
  END IF;

  RAISE NOTICE '== tops_detect_collection_anomalies inverted-float-direction test: PASS';
END $$;

ROLLBACK;
