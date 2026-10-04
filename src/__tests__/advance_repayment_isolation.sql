-- Advance repayment isolation invariants (pure DB, no fixtures).
-- Wrapped in a transaction and rolled back so nothing persists.
\set ON_ERROR_STOP on
BEGIN;

-- 1) Routing compatibility: agent_repayment must NEVER route to operational_wallet.
DO $$
BEGIN
  BEGIN
    PERFORM public.assert_routing_compatible('agent_repayment','operational_wallet');
    RAISE EXCEPTION 'FAIL: operational_wallet routing for agent_repayment was not blocked';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'PASS: operational_wallet routing blocked for agent_repayment';
  END;
END $$;

-- 2) Routing compatibility: agent_repayment to a user wallet IS allowed.
DO $$
BEGIN
  PERFORM public.assert_routing_compatible('agent_repayment','user');
  RAISE NOTICE 'PASS: user routing accepted for agent_repayment';
END $$;

-- 3) Same guard for related categories.
DO $$
DECLARE
  cat text;
BEGIN
  FOR cat IN SELECT unnest(ARRAY['agent_advance_repayment','salary_advance_repayment','debt_recovery']) LOOP
    BEGIN
      PERFORM public.assert_routing_compatible(cat, 'operational_wallet');
      RAISE EXCEPTION 'FAIL: % was not blocked from operational_wallet', cat;
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'PASS: % blocked from operational_wallet', cat;
    END;
  END LOOP;
END $$;

-- 4) wallet_route_for_category sanity: agent_repayment debit lands in withdrawable bucket.
DO $$
DECLARE
  v_bucket text;
  v_sign int;
BEGIN
  SELECT bucket, sign INTO v_bucket, v_sign
  FROM public.wallet_route_for_category('agent_repayment','cash_out');
  IF v_bucket <> 'withdrawable' OR v_sign <> -1 THEN
    RAISE EXCEPTION 'FAIL: agent_repayment routed to bucket=% sign=% (expected withdrawable/-1)', v_bucket, v_sign;
  END IF;
  RAISE NOTICE 'PASS: agent_repayment cash_out routes to withdrawable/-1';
END $$;

DO $$ BEGIN RAISE NOTICE 'PASS: advance repayment isolation invariants all green'; END $$;

ROLLBACK;
