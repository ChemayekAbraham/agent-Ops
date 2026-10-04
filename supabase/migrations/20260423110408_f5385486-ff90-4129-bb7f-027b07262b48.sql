-- Test routine for the 3-migration wallet drift fix.
-- Performs all writes inside a SAVEPOINT then ROLLBACK so nothing persists.
-- Uses a fully synthetic UUID never present in auth.users / profiles.

CREATE OR REPLACE FUNCTION public.test_wallet_drift_fix()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_test_user uuid := gen_random_uuid();
  v_report jsonb := '{}'::jsonb;

  v_balance_after_credit numeric;
  v_withdrawable_after  numeric;
  v_float_after         numeric;
  v_expected_balance    numeric;

  v_overdraw_count_before bigint;
  v_overdraw_count_after  bigint;

  v_unrouted_count_before bigint;
  v_unrouted_count_after  bigint;

  v_test1_pass boolean := false;
  v_test2_pass boolean := false;
  v_test3_pass boolean := false;
  v_err text;
BEGIN
  -- Caller authorization
  IF NOT (
    has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only super_admin or CFO can run wallet drift fix tests';
  END IF;

  -- Wrap entire test in a SAVEPOINT so we can roll back unconditionally
  BEGIN
    -- =====================================================================
    -- TEST 1: Double-count fix
    -- Credit 10,000 via apply_wallet_movement(wallet_deposit, cash_in).
    -- If sync_wallet_from_ledger were still active, we'd see 20,000.
    -- After the fix we should see exactly 10,000.
    --
    -- NOTE: We don't insert into general_ledger (which requires balanced
    -- legs and would fire BOTH triggers historically). Calling
    -- apply_wallet_movement directly proves the bucket math in isolation.
    -- We then ALSO insert a ledger row to confirm the trigger no-op.
    -- =====================================================================

    -- Create a synthetic wallet
    INSERT INTO public.wallets (user_id, balance, withdrawable_balance, float_balance, advance_balance)
    VALUES (v_test_user, 0, 0, 0, 0);

    -- Apply movement (sole writer path)
    PERFORM apply_wallet_movement(v_test_user, 'wallet_deposit', 10000, 'cash_in');

    -- Now insert a raw ledger row that targets this user.
    -- The neutered sync_wallet_from_ledger trigger should NOT add anything.
    -- We bypass create_ledger_transaction (which would call apply_wallet_movement
    -- again and balanced-legs validation). This is a pure trigger test.
    INSERT INTO public.general_ledger (
      user_id, ledger_scope, classification, category, direction, amount,
      description
    ) VALUES (
      v_test_user, 'wallet', 'test_dev', 'wallet_deposit', 'cash_in', 10000,
      'TEST: drift-fix verification (rolled back)'
    );

    SELECT balance, withdrawable_balance, float_balance
      INTO v_balance_after_credit, v_withdrawable_after, v_float_after
      FROM public.wallets WHERE user_id = v_test_user;

    v_expected_balance := 10000; -- single credit, no double-count
    v_test1_pass := (v_balance_after_credit = v_expected_balance
                     AND v_withdrawable_after = 10000);

    v_report := v_report || jsonb_build_object('test1_double_count_fix', jsonb_build_object(
      'passed', v_test1_pass,
      'expected_balance', v_expected_balance,
      'actual_balance', v_balance_after_credit,
      'actual_withdrawable', v_withdrawable_after,
      'actual_float', v_float_after,
      'note', CASE WHEN v_test1_pass
        THEN 'sync_wallet_from_ledger is a no-op; apply_wallet_movement is the sole writer'
        ELSE 'DOUBLE-COUNT STILL PRESENT — sync_wallet_from_ledger may be active again'
      END
    ));

    -- =====================================================================
    -- TEST 2: Overdraw logging
    -- Force a negative balance via direct UPDATE (with sync_authorized flag
    -- so the lockdown trigger lets us through). enforce_non_negative_balance
    -- should clamp to 0 AND log a row into wallet_overdraw_events.
    -- =====================================================================

    SELECT count(*) INTO v_overdraw_count_before
      FROM public.wallet_overdraw_events WHERE user_id = v_test_user;

    -- Authorize the write so the lockdown trigger doesn't reject us
    PERFORM set_config('wallet.sync_authorized', 'true', true);

    -- Force negative balance
    UPDATE public.wallets
       SET balance = -50000, updated_at = now()
     WHERE user_id = v_test_user;

    PERFORM set_config('wallet.sync_authorized', 'false', true);

    SELECT count(*) INTO v_overdraw_count_after
      FROM public.wallet_overdraw_events WHERE user_id = v_test_user;

    SELECT balance INTO v_balance_after_credit
      FROM public.wallets WHERE user_id = v_test_user;

    v_test2_pass := (v_overdraw_count_after = v_overdraw_count_before + 1
                     AND v_balance_after_credit = 0);

    v_report := v_report || jsonb_build_object('test2_overdraw_logging', jsonb_build_object(
      'passed', v_test2_pass,
      'overdraw_events_before', v_overdraw_count_before,
      'overdraw_events_after', v_overdraw_count_after,
      'balance_after_clamp', v_balance_after_credit,
      'note', CASE WHEN v_test2_pass
        THEN 'enforce_non_negative_balance clamps to 0 AND logs the event'
        ELSE 'OVERDRAW LOGGING BROKEN — clamp may still be silent'
      END
    ));

    -- =====================================================================
    -- TEST 3: Unrouted category logging
    -- Call apply_wallet_movement with a category that has no route.
    -- Should write nothing to wallets but log to wallet_unrouted_movements.
    -- =====================================================================

    SELECT count(*) INTO v_unrouted_count_before
      FROM public.wallet_unrouted_movements WHERE user_id = v_test_user;

    -- A made-up category guaranteed not to route
    PERFORM apply_wallet_movement(
      v_test_user,
      '__test_drift_fix_synthetic_unrouted__',
      777,
      'cash_in'
    );

    SELECT count(*) INTO v_unrouted_count_after
      FROM public.wallet_unrouted_movements WHERE user_id = v_test_user;

    v_test3_pass := (v_unrouted_count_after = v_unrouted_count_before + 1);

    v_report := v_report || jsonb_build_object('test3_unrouted_logging', jsonb_build_object(
      'passed', v_test3_pass,
      'unrouted_events_before', v_unrouted_count_before,
      'unrouted_events_after', v_unrouted_count_after,
      'note', CASE WHEN v_test3_pass
        THEN 'apply_wallet_movement now logs route=none categories instead of silent return'
        ELSE 'UNROUTED LOGGING BROKEN — categories still vanish silently'
      END
    ));

    -- Force rollback by raising a sentinel exception
    RAISE EXCEPTION 'WALLET_DRIFT_TEST_ROLLBACK';

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err <> 'WALLET_DRIFT_TEST_ROLLBACK' THEN
      -- Real error — surface it
      v_report := v_report || jsonb_build_object('runtime_error', v_err);
    END IF;
  END;

  -- At this point the SAVEPOINT block has rolled back. The synthetic wallet,
  -- ledger row, overdraw event, and unrouted-movement row no longer exist.
  -- Belt-and-suspenders cleanup in case any row leaked outside the block:
  DELETE FROM public.wallet_unrouted_movements WHERE user_id = v_test_user;
  DELETE FROM public.wallet_overdraw_events    WHERE user_id = v_test_user;
  DELETE FROM public.general_ledger
    WHERE user_id = v_test_user
      AND description = 'TEST: drift-fix verification (rolled back)';
  DELETE FROM public.wallets WHERE user_id = v_test_user;

  v_report := v_report || jsonb_build_object(
    'summary', jsonb_build_object(
      'test_user_id', v_test_user,
      'all_passed', (v_test1_pass AND v_test2_pass AND v_test3_pass),
      'tests_passed', (v_test1_pass::int + v_test2_pass::int + v_test3_pass::int),
      'tests_total', 3,
      'persistence', 'none — all writes rolled back / cleaned up',
      'ran_at', now()
    )
  );

  RETURN v_report;
END;
$function$;

COMMENT ON FUNCTION public.test_wallet_drift_fix() IS
  'Background test for the 3-migration wallet drift fix (2026-04-23). All operations are rolled back; no data persists. super_admin / cfo only.';

REVOKE ALL ON FUNCTION public.test_wallet_drift_fix() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.test_wallet_drift_fix() TO authenticated;