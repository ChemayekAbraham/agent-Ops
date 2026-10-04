
CREATE OR REPLACE FUNCTION public.reconcile_wallet_from_ledger(
  p_user_id uuid,
  p_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller          uuid := auth.uid();
  v_is_authorized   boolean;
  v_cached_balance  numeric := 0;
  v_cached_withdraw numeric := 0;
  v_cached_float    numeric := 0;
  v_cached_advance  numeric := 0;
  v_ledger_net      numeric := 0;
  v_delta           numeric := 0;
  v_direction       text;
  v_amount_abs      numeric;
  v_txn_group       uuid := gen_random_uuid();
  v_correction_id   uuid;
  v_platform_id     uuid;
BEGIN
  IF v_caller IS NULL THEN
    v_is_authorized := true;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_caller
        AND role::text IN ('cfo','super_admin','manager')
    ) INTO v_is_authorized;
  END IF;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'reconcile_wallet_from_ledger: caller % is not CFO/super_admin/manager', v_caller;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'reconcile_wallet_from_ledger: reason must be at least 10 characters';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'reconcile_wallet_from_ledger: p_user_id is required';
  END IF;

  SELECT COALESCE(balance,0), COALESCE(withdrawable_balance,0),
         COALESCE(float_balance,0), COALESCE(advance_balance,0)
    INTO v_cached_balance, v_cached_withdraw, v_cached_float, v_cached_advance
  FROM public.wallets
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconcile_wallet_from_ledger: wallet not found for user %', p_user_id;
  END IF;

  SELECT COALESCE(SUM(
           CASE WHEN direction = 'cash_in'  THEN amount
                WHEN direction = 'cash_out' THEN -amount
                ELSE 0 END
         ), 0)
    INTO v_ledger_net
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production');

  v_delta := v_cached_balance - v_ledger_net;

  IF ROUND(v_delta) = 0 THEN
    RETURN jsonb_build_object(
      'status',          'already_in_sync',
      'user_id',         p_user_id,
      'cached_balance',  v_cached_balance,
      'ledger_net',      v_ledger_net
    );
  END IF;

  SELECT user_id INTO v_platform_id
  FROM public.user_roles
  WHERE role::text = 'super_admin'
  ORDER BY created_at NULLS LAST
  LIMIT 1;
  v_platform_id := COALESCE(v_platform_id, v_caller);

  v_amount_abs := abs(v_delta);

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  IF v_delta > 0 THEN
    v_direction := 'writedown';

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, description,
      ledger_scope, classification, transaction_group_id, transaction_date
    ) VALUES (
      p_user_id, v_amount_abs, 'cash_out', 'system_balance_correction',
      'Ledger reconciliation writedown — ' || p_reason,
      'wallet', 'admin_correction', v_txn_group, now()
    ) RETURNING id INTO v_correction_id;

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, description,
      ledger_scope, classification, transaction_group_id, transaction_date
    ) VALUES (
      v_platform_id, v_amount_abs, 'cash_in', 'system_balance_correction',
      'Ledger reconciliation writedown (platform leg) for user ' || p_user_id::text,
      'platform', 'admin_correction', v_txn_group, now()
    );

    UPDATE public.wallets
       SET withdrawable_balance = GREATEST(0, withdrawable_balance - LEAST(v_amount_abs, withdrawable_balance)),
           float_balance        = float_balance
                                  - GREATEST(0, v_amount_abs - LEAST(v_amount_abs, withdrawable_balance)),
           balance              = GREATEST(0, balance - v_amount_abs),
           updated_at           = now()
     WHERE user_id = p_user_id;

  ELSE
    v_direction := 'release';

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, description,
      ledger_scope, classification, transaction_group_id, transaction_date
    ) VALUES (
      p_user_id, v_amount_abs, 'cash_in', 'system_balance_correction',
      'Ledger reconciliation release — ' || p_reason,
      'wallet', 'admin_correction', v_txn_group, now()
    ) RETURNING id INTO v_correction_id;

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, description,
      ledger_scope, classification, transaction_group_id, transaction_date
    ) VALUES (
      v_platform_id, v_amount_abs, 'cash_out', 'system_balance_correction',
      'Ledger reconciliation release (platform leg) for user ' || p_user_id::text,
      'platform', 'admin_correction', v_txn_group, now()
    );

    UPDATE public.wallets
       SET withdrawable_balance = withdrawable_balance + v_amount_abs,
           balance              = balance + v_amount_abs,
           updated_at           = now()
     WHERE user_id = p_user_id;
  END IF;

  -- audit_logs (no `reason` column — store reason inside metadata)
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, action, metadata
  ) VALUES (
    v_caller, 'wallet_full_reconciliation', 'wallets', p_user_id,
    'reconcile_to_ledger',
    jsonb_build_object(
      'reason',             p_reason,
      'before', jsonb_build_object(
        'balance',              v_cached_balance,
        'withdrawable_balance', v_cached_withdraw,
        'float_balance',        v_cached_float,
        'advance_balance',      v_cached_advance
      ),
      'ledger_net',         v_ledger_net,
      'delta',              v_delta,
      'direction',          v_direction,
      'transaction_group',  v_txn_group,
      'correction_id',      v_correction_id
    )
  );

  -- system_events uses `metadata`, not `payload`
  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES (
      'wallet.reconciled_from_ledger',
      p_user_id,
      jsonb_build_object(
        'reconciled_by', v_caller,
        'delta',         v_delta,
        'direction',     v_direction,
        'reason',        p_reason
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'status',         'reconciled',
    'user_id',        p_user_id,
    'before_balance', v_cached_balance,
    'ledger_net',     v_ledger_net,
    'delta',          v_delta,
    'direction',      v_direction,
    'transaction_group', v_txn_group
  );
END;
$$;
