DO $$
DECLARE
  v_agent uuid := 'f5cba52e-df88-404a-b417-efe6d8690d60';
  v_tenant uuid;
  v_dep_a uuid;
  v_dep_b uuid;
  v_dep_d uuid;
  v_w_before record;
  v_w_after_a record;
  v_w_after_b record;
  v_w_after_d record;
  v_count_a int;
  v_count_b int;
BEGIN
  -- Pick any tenant id to satisfy the operational-float allocation trigger.
  SELECT user_id INTO v_tenant FROM user_roles WHERE role='tenant' LIMIT 1;

  INSERT INTO wallets (user_id, balance) VALUES (v_agent, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT withdrawable_balance, float_balance, balance INTO v_w_before
  FROM wallets WHERE user_id = v_agent;
  RAISE NOTICE 'BEFORE: withdrawable=% float=% balance=%',
    v_w_before.withdrawable_balance, v_w_before.float_balance, v_w_before.balance;

  -- ─── Test A: operational_float deposit (with allocation payload) ───
  INSERT INTO deposit_requests (user_id, amount, provider, status, deposit_purpose, transaction_id, agent_id, notes)
  VALUES (v_agent, 100000, 'mtn', 'pending', 'operational_float',
          'ROUTETEST-A-' || gen_random_uuid()::text, v_agent,
          format('test float deposit [ALLOCATIONS][{"tid":"%s","a":100000}]', v_tenant))
  RETURNING id INTO v_dep_a;

  PERFORM create_ledger_transaction(jsonb_build_array(
    jsonb_build_object(
      'user_id', v_agent, 'amount', 100000, 'direction','cash_in',
      'category','agent_float_deposit','ledger_scope','wallet',
      'source_table','deposit_requests','source_id', v_dep_a,
      'reference_id', v_dep_a, 'description','TEST A float',
      'currency','UGX','transaction_date', now()
    ),
    jsonb_build_object(
      'amount', 100000, 'direction','cash_out',
      'category','agent_float_deposit','ledger_scope','platform',
      'source_table','deposit_requests','source_id', v_dep_a,
      'description','TEST A float platform','currency','UGX',
      'transaction_date', now()
    )
  ));
  UPDATE deposit_requests SET status='approved', approved_at=now() WHERE id = v_dep_a;

  SELECT withdrawable_balance, float_balance, balance INTO v_w_after_a
  FROM wallets WHERE user_id = v_agent;
  RAISE NOTICE 'AFTER A (float +100k): withdrawable=% (Δ=%) float=% (Δ=%) balance=%',
    v_w_after_a.withdrawable_balance, v_w_after_a.withdrawable_balance - v_w_before.withdrawable_balance,
    v_w_after_a.float_balance,        v_w_after_a.float_balance        - v_w_before.float_balance,
    v_w_after_a.balance;

  -- ─── Test B: personal_deposit ───
  INSERT INTO deposit_requests (user_id, amount, provider, status, deposit_purpose, transaction_id, agent_id)
  VALUES (v_agent, 50000, 'mtn', 'pending', 'personal_deposit',
          'ROUTETEST-B-' || gen_random_uuid()::text, v_agent)
  RETURNING id INTO v_dep_b;

  PERFORM create_ledger_transaction(jsonb_build_array(
    jsonb_build_object(
      'user_id', v_agent, 'amount', 50000, 'direction','cash_in',
      'category','wallet_deposit','ledger_scope','wallet',
      'source_table','deposit_requests','source_id', v_dep_b,
      'reference_id', v_dep_b, 'description','TEST B personal',
      'currency','UGX','transaction_date', now()
    ),
    jsonb_build_object(
      'amount', 50000, 'direction','cash_out',
      'category','wallet_deposit','ledger_scope','platform',
      'source_table','deposit_requests','source_id', v_dep_b,
      'description','TEST B personal platform','currency','UGX',
      'transaction_date', now()
    )
  ));
  UPDATE deposit_requests SET status='approved', approved_at=now() WHERE id = v_dep_b;

  SELECT withdrawable_balance, float_balance, balance INTO v_w_after_b
  FROM wallets WHERE user_id = v_agent;
  RAISE NOTICE 'AFTER B (personal +50k): withdrawable=% (Δ=%) float=% (Δ=%) balance=%',
    v_w_after_b.withdrawable_balance, v_w_after_b.withdrawable_balance - v_w_after_a.withdrawable_balance,
    v_w_after_b.float_balance,        v_w_after_b.float_balance        - v_w_after_a.float_balance,
    v_w_after_b.balance;

  -- ─── Test D: pending deposit (no ledger insert / no approval) ───
  INSERT INTO deposit_requests (user_id, amount, provider, status, deposit_purpose, transaction_id, agent_id)
  VALUES (v_agent, 999999, 'mtn', 'pending', 'personal_deposit',
          'ROUTETEST-D-' || gen_random_uuid()::text, v_agent)
  RETURNING id INTO v_dep_d;
  SELECT withdrawable_balance, float_balance, balance INTO v_w_after_d
  FROM wallets WHERE user_id = v_agent;
  RAISE NOTICE 'AFTER D (pending no-op): withdrawable=% float=% balance=% (must equal AFTER B)',
    v_w_after_d.withdrawable_balance, v_w_after_d.float_balance, v_w_after_d.balance;

  -- ─── Test C: idempotency lookup detects BOTH categories ───
  SELECT count(*) INTO v_count_a FROM general_ledger
   WHERE source_table='deposit_requests' AND source_id = v_dep_a
     AND category IN ('wallet_deposit','agent_float_deposit')
     AND direction='cash_in' AND ledger_scope='wallet';
  SELECT count(*) INTO v_count_b FROM general_ledger
   WHERE source_table='deposit_requests' AND source_id = v_dep_b
     AND category IN ('wallet_deposit','agent_float_deposit')
     AND direction='cash_in' AND ledger_scope='wallet';
  RAISE NOTICE 'TEST C lookup: float dep=% credits, personal dep=% credits (both must be 1)',
    v_count_a, v_count_b;
  IF v_count_a <> 1 OR v_count_b <> 1 THEN
    RAISE EXCEPTION 'TEST C FAILED: idempotency lookup did not detect exactly 1 credit per deposit';
  END IF;

  -- ─── Final invariants ───
  IF v_w_after_a.float_balance - v_w_before.float_balance <> 100000 THEN
    RAISE EXCEPTION 'TEST A FAILED: float Δ=% (expected 100000)',
      v_w_after_a.float_balance - v_w_before.float_balance;
  END IF;
  IF v_w_after_a.withdrawable_balance - v_w_before.withdrawable_balance <> 0 THEN
    RAISE EXCEPTION 'TEST A FAILED: withdrawable changed on float deposit (Δ=%)',
      v_w_after_a.withdrawable_balance - v_w_before.withdrawable_balance;
  END IF;
  IF v_w_after_b.withdrawable_balance - v_w_after_a.withdrawable_balance <> 50000 THEN
    RAISE EXCEPTION 'TEST B FAILED: withdrawable Δ=% (expected 50000)',
      v_w_after_b.withdrawable_balance - v_w_after_a.withdrawable_balance;
  END IF;
  IF v_w_after_b.float_balance - v_w_after_a.float_balance <> 0 THEN
    RAISE EXCEPTION 'TEST B FAILED: float changed on personal deposit (Δ=%)',
      v_w_after_b.float_balance - v_w_after_a.float_balance;
  END IF;
  IF v_w_after_d.balance <> v_w_after_b.balance THEN
    RAISE EXCEPTION 'TEST D FAILED: pending deposit changed balance (% vs %)',
      v_w_after_d.balance, v_w_after_b.balance;
  END IF;
  IF v_w_after_b.balance <> v_w_after_b.withdrawable_balance + v_w_after_b.float_balance THEN
    RAISE EXCEPTION 'INVARIANT FAILED: balance(%) <> withdrawable(%) + float(%)',
      v_w_after_b.balance, v_w_after_b.withdrawable_balance, v_w_after_b.float_balance;
  END IF;

  RAISE NOTICE 'ALL TESTS PASSED ✅ — float→float, personal→withdrawable, pending no-op, invariant holds';
END $$;