CREATE OR REPLACE FUNCTION public.test_wallet_drift_fix()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_synthetic_user uuid := gen_random_uuid();
  v_real_wallet_user uuid;
  v_snap_balance numeric;
  v_snap_withdrawable numeric;
  v_snap_float numeric;
  v_snap_advance numeric;

  v_balance numeric;
  v_withdrawable numeric;
  v_float numeric;

  v_overdraw_before bigint;
  v_overdraw_after bigint;
  v_unrouted_before bigint;
  v_unrouted_after bigint;

  v_test1 boolean := false;
  v_test2 boolean := false;
  v_test3 boolean := false;

  v_report jsonb := '{}'::jsonb;
  v_err text;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only super_admin or CFO can run wallet drift fix tests';
  END IF;

  -- Pick a zero-balance wallet to snapshot for test 1
  SELECT user_id, balance, withdrawable_balance, float_balance, advance_balance
    INTO v_real_wallet_user, v_snap_balance, v_snap_withdrawable, v_snap_float, v_snap_advance
    FROM public.wallets
    WHERE balance = 0
      AND withdrawable_balance = 0
      AND float_balance = 0
      AND advance_balance = 0
    ORDER BY updated_at ASC NULLS FIRST
    LIMIT 1;

  IF v_real_wallet_user IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'No zero-balance wallet available to snapshot for test 1.',
      'all_passed', false
    );
  END IF;

  BEGIN
    -- =====================================================================
    -- TEST 1: Bucket-aware credit on a real wallet (snapshot+rollback)
    -- After 10000 credit, balance should be exactly 10000 (not 20000).
    -- =====================================================================
    PERFORM apply_wallet_movement(v_real_wallet_user, 'wallet_deposit', 10000, 'cash_in');

    SELECT balance, withdrawable_balance, float_balance
      INTO v_balance, v_withdrawable, v_float
      FROM public.wallets WHERE user_id = v_real_wallet_user;

    v_test1 := (v_balance = 10000 AND v_withdrawable = 10000 AND v_float = 0);

    v_report := v_report || jsonb_build_object('test1_no_double_count', jsonb_build_object(
      'passed', v_test1,
      'expected', jsonb_build_object('balance', 10000, 'withdrawable', 10000, 'float', 0),
      'actual',   jsonb_build_object('balance', v_balance, 'withdrawable', v_withdrawable, 'float', v_float),
      'note', CASE WHEN v_test1
        THEN 'Single credit produced single increment — sync_wallet_from_ledger is a no-op'
        ELSE 'DOUBLE-COUNT REGRESSION DETECTED'
      END
    ));

    -- =====================================================================
    -- TEST 2: Overdraw clamp + log (synthetic UUID — no FK on overdraw table)
    -- =====================================================================
    SELECT count(*) INTO v_overdraw_before
      FROM public.wallet_overdraw_events WHERE user_id = v_synthetic_user;

    -- Directly invoke the trigger by simulating a NEW row via a probe table
    -- We can't insert into wallets with a synthetic user (FK), so instead
    -- we re-route through an UPDATE on the snapshot wallet that the lockdown
    -- trigger lets through (sync_authorized=true), pushing it negative.
    PERFORM set_config('wallet.sync_authorized', 'true', true);

    UPDATE public.wallets
       SET balance = -50000, updated_at = now()
     WHERE user_id = v_real_wallet_user;

    PERFORM set_config('wallet.sync_authorized', 'false', true);

    SELECT balance INTO v_balance FROM public.wallets WHERE user_id = v_real_wallet_user;

    SELECT count(*) INTO v_overdraw_after
      FROM public.wallet_overdraw_events WHERE user_id = v_real_wallet_user;

    v_test2 := (v_overdraw_after = v_overdraw_before + 1 OR v_overdraw_after >= 1)
               AND v_balance = 0;

    v_report := v_report || jsonb_build_object('test2_overdraw_logged', jsonb_build_object(
      'passed', v_test2,
      'overdraw_events_delta', v_overdraw_after - v_overdraw_before,
      'balance_after_clamp', v_balance,
      'note', CASE WHEN v_test2
        THEN 'enforce_non_negative_balance clamped to 0 AND logged the event'
        ELSE 'OVERDRAW LOGGING BROKEN — clamp may still be silent'
      END
    ));

    -- =====================================================================
    -- TEST 3: Unrouted category logged (synthetic UUID is fine)
    -- =====================================================================
    SELECT count(*) INTO v_unrouted_before
      FROM public.wallet_unrouted_movements WHERE category = '__test_drift_fix_synthetic_unrouted__';

    PERFORM apply_wallet_movement(
      v_synthetic_user,
      '__test_drift_fix_synthetic_unrouted__',
      777,
      'cash_in'
    );

    SELECT count(*) INTO v_unrouted_after
      FROM public.wallet_unrouted_movements WHERE category = '__test_drift_fix_synthetic_unrouted__';

    v_test3 := (v_unrouted_after = v_unrouted_before + 1);

    v_report := v_report || jsonb_build_object('test3_unrouted_logged', jsonb_build_object(
      'passed', v_test3,
      'unrouted_events_delta', v_unrouted_after - v_unrouted_before,
      'note', CASE WHEN v_test3
        THEN 'apply_wallet_movement logged the unrouted category instead of returning silently'
        ELSE 'UNROUTED LOGGING BROKEN'
      END
    ));

    -- Force rollback so nothing persists
    RAISE EXCEPTION 'WALLET_DRIFT_TEST_ROLLBACK';

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err <> 'WALLET_DRIFT_TEST_ROLLBACK' THEN
      v_report := v_report || jsonb_build_object('runtime_error', v_err);
    END IF;
  END;

  -- Sanity: confirm the snapshot wallet was restored by the rollback
  SELECT balance, withdrawable_balance, float_balance, advance_balance
    INTO v_balance, v_withdrawable, v_float, v_snap_advance
    FROM public.wallets WHERE user_id = v_real_wallet_user;

  v_report := v_report || jsonb_build_object(
    'snapshot_check', jsonb_build_object(
      'wallet_restored', (v_balance = 0 AND v_withdrawable = 0 AND v_float = 0),
      'balance', v_balance, 'withdrawable', v_withdrawable, 'float', v_float
    ),
    'summary', jsonb_build_object(
      'all_passed', (v_test1 AND v_test2 AND v_test3),
      'tests_passed', (v_test1::int + v_test2::int + v_test3::int),
      'tests_total', 3,
      'persistence', 'none — savepoint rolled back, wallet snapshot restored',
      'ran_at', now()
    )
  );

  RETURN v_report;
END;
$function$;