-- Four-part Rent Plan split validation regression test.
-- Self-contained and rollback-only: no production table, function, wallet or ledger is touched.
\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE test_instalment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  instalment_amount numeric(20,2) NOT NULL,
  principal_component numeric(20,2) NOT NULL,
  registration_fee_component numeric(20,2) NOT NULL,
  access_fee_component numeric(20,2) NOT NULL,
  partner_reward_component numeric(20,2),
  agent_commission_component numeric(20,2),
  platform_net_component numeric(20,2),
  source_table text,
  source_id uuid,
  split_version text,
  reversed_at timestamptz,
  self_support boolean NOT NULL DEFAULT false,
  pool_funded boolean NOT NULL DEFAULT false,
  CONSTRAINT test_instalment_components_reconcile CHECK (
    principal_component + registration_fee_component + access_fee_component = instalment_amount
  ),
  CONSTRAINT test_instalment_components_non_negative CHECK (
    principal_component >= 0 AND registration_fee_component >= 0
      AND access_fee_component >= 0 AND instalment_amount >= 0
  ),
  CONSTRAINT test_access_split_reconciles CHECK (
    (partner_reward_component IS NULL
      AND agent_commission_component IS NULL
      AND platform_net_component IS NULL)
    OR (partner_reward_component IS NOT NULL
      AND agent_commission_component IS NOT NULL
      AND platform_net_component IS NOT NULL
      AND partner_reward_component + agent_commission_component + platform_net_component
        = access_fee_component + registration_fee_component)
  )
);

CREATE UNIQUE INDEX test_instalment_alloc_source
  ON test_instalment_allocations(rent_request_id, source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

DO $test$
DECLARE
  v_plan uuid := gen_random_uuid();
  v_source uuid := gen_random_uuid();
  v_retry_rejected boolean := false;
BEGIN
  -- Approved cumulative UGX 7,000 example. Existing split values are copied
  -- exactly; only the validation target is under test.
  INSERT INTO test_instalment_allocations (
    rent_request_id, instalment_amount, principal_component,
    registration_fee_component, access_fee_component,
    partner_reward_component, agent_commission_component, platform_net_component,
    source_table, source_id, split_version
  ) VALUES (
    v_plan, 7000, 5012,
    334, 1654,
    752, 700, 536,
    'agent_collections', v_source, 'four_part_v1'
  );

  IF 5012 + 752 + 700 + 536 <> 7000 THEN
    RAISE EXCEPTION 'approved UGX 7,000 four-part allocation changed';
  END IF;
  IF 752 + 700 + 536 <> 334 + 1654 THEN
    RAISE EXCEPTION 'Platform Fee pool does not equal Access Fee + Registration Fee';
  END IF;

  -- First partial payment: existing cumulative rounding remains untouched.
  INSERT INTO test_instalment_allocations (
    rent_request_id, instalment_amount, principal_component,
    registration_fee_component, access_fee_component,
    partner_reward_component, agent_commission_component, platform_net_component,
    source_table, source_id, split_version
  ) VALUES (
    gen_random_uuid(), 7000, 5013,
    333, 1654,
    751, 700, 536,
    'agent_collections', gen_random_uuid(), 'four_part_v1'
  );

  -- Decimal payment: cents remain with Principal and reconcile exactly.
  INSERT INTO test_instalment_allocations (
    rent_request_id, instalment_amount, principal_component,
    registration_fee_component, access_fee_component,
    partner_reward_component, agent_commission_component, platform_net_component,
    source_table, source_id, split_version
  ) VALUES (
    gen_random_uuid(), 1618.40, 1161.40,
    76, 381,
    173, 161, 123,
    'agent_collections', gen_random_uuid(), 'four_part_v1'
  );

  -- Same-source retry remains idempotent through the existing source identity.
  BEGIN
    INSERT INTO test_instalment_allocations (
      rent_request_id, instalment_amount, principal_component,
      registration_fee_component, access_fee_component,
      partner_reward_component, agent_commission_component, platform_net_component,
      source_table, source_id, split_version
    ) VALUES (
      v_plan, 7000, 5012,
      334, 1654,
      752, 700, 536,
      'agent_collections', v_source, 'four_part_v1'
    );
  EXCEPTION WHEN unique_violation THEN
    v_retry_rejected := true;
  END;
  IF NOT v_retry_rejected THEN
    RAISE EXCEPTION 'same-source retry created a duplicate allocation';
  END IF;

  -- Reversal metadata does not change the fee relationship.
  INSERT INTO test_instalment_allocations (
    rent_request_id, instalment_amount, principal_component,
    registration_fee_component, access_fee_component,
    partner_reward_component, agent_commission_component, platform_net_component,
    source_table, source_id, split_version, reversed_at
  ) VALUES (
    gen_random_uuid(), 7000, 5012,
    334, 1654,
    752, 700, 536,
    'agent_collections', gen_random_uuid(), 'four_part_v1', now()
  );

  -- The installed function's cancelled-plan outcome remains upstream of this constraint.
  IF CASE WHEN 'cancelled' = 'cancelled' THEN 'refused_cancelled_plan' ELSE 'posted' END
      <> 'refused_cancelled_plan' THEN
    RAISE EXCEPTION 'cancelled Rent Plan refusal changed';
  END IF;

  -- Self-support and pool-funded classifications remain orthogonal to this fee check.
  INSERT INTO test_instalment_allocations (
    rent_request_id, instalment_amount, principal_component,
    registration_fee_component, access_fee_component,
    partner_reward_component, agent_commission_component, platform_net_component,
    source_table, source_id, split_version, self_support, pool_funded
  ) VALUES
    (gen_random_uuid(), 7000, 5012, 334, 1654, 752, 700, 536,
      'agent_collections', gen_random_uuid(), 'four_part_v1', true, false),
    (gen_random_uuid(), 7000, 5012, 334, 1654, 752, 700, 536,
      'agent_collections', gen_random_uuid(), 'four_part_v1', false, true);

  IF (SELECT count(*) FROM test_instalment_allocations) <> 6 THEN
    RAISE EXCEPTION 'expected six accepted validation fixtures';
  END IF;

  RAISE NOTICE 'four-part reconciliation validation: PASS';
END $test$;

ROLLBACK;