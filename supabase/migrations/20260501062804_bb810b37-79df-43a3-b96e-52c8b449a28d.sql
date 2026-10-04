-- Fix bulk ledger-truth reconciliation so correction entries use the authorized ledger engine
-- and impossible negative wallet targets do not remain unreconcilable.

CREATE OR REPLACE FUNCTION public.create_ledger_transaction(
  entries jsonb,
  idempotency_key text DEFAULT NULL::text,
  skip_balance_check boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_entry jsonb;
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_entry_count int := 0;
  v_total_amount numeric := 0;
  v_user_balance numeric;
  v_lock_key bigint;
  v_wallet_id uuid;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    v_lock_key := abs(hashtext(idempotency_key));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT transaction_group_id INTO v_group_id
    FROM public.general_ledger
    WHERE general_ledger.idempotency_key = create_ledger_transaction.idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_group_id IS NOT NULL THEN
      RETURN v_group_id;
    END IF;
  END IF;

  v_group_id := gen_random_uuid();

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF (v_entry->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'All amounts must be positive, got: %', v_entry->>'amount';
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      IF NOT skip_balance_check AND COALESCE(v_entry->>'ledger_scope', 'wallet') = 'wallet' THEN
        SELECT COALESCE(SUM(
          CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END
        ), 0) INTO v_user_balance
        FROM public.general_ledger
        WHERE user_id = (v_entry->>'user_id')::uuid
          AND ledger_scope = 'wallet';

        IF v_user_balance < (v_entry->>'amount')::numeric THEN
          RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
            v_entry->>'user_id', v_user_balance, v_entry->>'amount';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', v_entry->>'direction';
    END IF;

    v_entry_count := v_entry_count + 1;
    v_total_amount := v_total_amount + (v_entry->>'amount')::numeric;
  END LOOP;

  IF v_total_in <> v_total_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_total_in, v_total_out;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    v_wallet_id := NULL;
    IF (v_entry->>'user_id') IS NOT NULL THEN
      SELECT id INTO v_wallet_id
      FROM public.wallets
      WHERE user_id = (v_entry->>'user_id')::uuid;
    END IF;

    INSERT INTO public.general_ledger (
      user_id, wallet_id, ledger_scope, direction, category, amount, currency,
      description, source_table, source_id, transaction_group_id,
      idempotency_key, transaction_date, linked_party, reference_id, account,
      classification
    ) VALUES (
      (v_entry->>'user_id')::uuid,
      v_wallet_id,
      COALESCE(v_entry->>'ledger_scope', 'wallet'),
      v_entry->>'direction',
      v_entry->>'category',
      (v_entry->>'amount')::numeric,
      COALESCE(v_entry->>'currency', 'UGX'),
      v_entry->>'description',
      COALESCE(v_entry->>'source_table', 'ledger_transaction'),
      (v_entry->>'source_id')::uuid,
      v_group_id,
      create_ledger_transaction.idempotency_key,
      COALESCE((v_entry->>'transaction_date')::timestamptz, now()),
      v_entry->>'linked_party',
      v_entry->>'reference_id',
      v_entry->>'account',
      COALESCE(v_entry->>'classification', 'production')
    );
  END LOOP;

  RETURN v_group_id;
END;
$function$;

CREATE OR REPLACE VIEW public.wallet_ledger_truth_view AS
WITH ledger_truth AS (
  SELECT
    user_id,
    SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount
             WHEN direction IN ('cash_out','debit') THEN -amount
             ELSE 0 END) AS ledger_net
  FROM public.general_ledger
  WHERE ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production')
  GROUP BY user_id
), wallet_truth AS (
  SELECT
    w.user_id,
    COALESCE(lt.ledger_net, 0)::numeric AS ledger_net,
    GREATEST(COALESCE(lt.ledger_net, 0), 0)::numeric AS target_cached_balance
  FROM public.wallets w
  LEFT JOIN ledger_truth lt ON lt.user_id = w.user_id
)
SELECT
  w.user_id,
  COALESCE(p.full_name, '(unknown)')          AS full_name,
  w.balance                                    AS cached_balance,
  w.withdrawable_balance                       AS cached_withdrawable,
  w.float_balance                              AS cached_float,
  w.advance_balance                            AS cached_advance,
  wt.ledger_net                                AS ledger_net,
  (w.balance - wt.target_cached_balance)       AS drift_amount,
  CASE
    WHEN ROUND(w.balance) = ROUND(wt.target_cached_balance) THEN 'in_sync'
    WHEN w.balance > wt.target_cached_balance                THEN 'phantom_air'
    ELSE 'hidden_owed'
  END                                           AS drift_direction,
  w.updated_at
FROM public.wallets w
JOIN wallet_truth wt ON wt.user_id = w.user_id
LEFT JOIN public.profiles p ON p.id = w.user_id;

GRANT SELECT ON public.wallet_ledger_truth_view TO authenticated;

CREATE OR REPLACE FUNCTION public.reconcile_wallet_from_ledger(
  p_user_id uuid,
  p_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller          uuid := auth.uid();
  v_is_authorized   boolean;
  v_cached_balance  numeric := 0;
  v_cached_withdraw numeric := 0;
  v_cached_float    numeric := 0;
  v_cached_advance  numeric := 0;
  v_ledger_net      numeric := 0;
  v_target_balance  numeric := 0;
  v_delta           numeric := 0;
  v_direction       text;
  v_amount_abs      numeric;
  v_txn_group       uuid;
  v_correction_id   uuid;
  v_withdraw_drain  numeric := 0;
  v_float_drain     numeric := 0;
BEGIN
  IF v_caller IS NULL THEN
    v_is_authorized := true;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_caller
        AND role::text IN ('cfo','super_admin','manager')
        AND COALESCE(enabled, true) = true
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
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconcile_wallet_from_ledger: wallet not found for user %', p_user_id;
  END IF;

  SELECT COALESCE(SUM(
           CASE WHEN direction IN ('cash_in','credit') THEN amount
                WHEN direction IN ('cash_out','debit') THEN -amount
                ELSE 0 END
         ), 0)
    INTO v_ledger_net
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production');

  v_target_balance := GREATEST(v_ledger_net, 0);
  v_delta := v_cached_balance - v_target_balance;

  IF ROUND(v_delta) = 0 THEN
    RETURN jsonb_build_object(
      'status',          'already_in_sync',
      'user_id',         p_user_id,
      'cached_balance',  v_cached_balance,
      'ledger_net',      v_ledger_net,
      'target_balance',  v_target_balance
    );
  END IF;

  v_amount_abs := abs(v_delta);

  PERFORM set_config('ledger.skip_bucket_sync', 'true', true);

  IF v_delta > 0 THEN
    v_direction := 'writedown';

    v_txn_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', p_user_id,
          'amount', v_amount_abs,
          'direction', 'cash_out',
          'category', 'system_balance_correction',
          'ledger_scope', 'wallet',
          'classification', 'admin_correction',
          'source_table', 'wallet_reconciliation',
          'description', 'Ledger reconciliation writedown — ' || p_reason,
          'reference_id', 'ledger_reconcile_' || p_user_id::text || '_' || extract(epoch from now())::bigint::text
        ),
        jsonb_build_object(
          'user_id', NULL,
          'amount', v_amount_abs,
          'direction', 'cash_in',
          'category', 'system_balance_correction',
          'ledger_scope', 'platform',
          'classification', 'admin_correction',
          'source_table', 'wallet_reconciliation',
          'description', 'Ledger reconciliation writedown platform leg for user ' || p_user_id::text,
          'reference_id', 'ledger_reconcile_' || p_user_id::text || '_' || extract(epoch from now())::bigint::text
        )
      ),
      'ledger-reconcile-' || p_user_id::text || '-' || md5(v_cached_balance::text || ':' || v_ledger_net::text || ':' || v_amount_abs::text || ':' || current_date::text),
      true
    );

    SELECT id INTO v_correction_id
    FROM public.general_ledger
    WHERE transaction_group_id = v_txn_group
      AND user_id = p_user_id
      AND ledger_scope = 'wallet'
    ORDER BY created_at ASC
    LIMIT 1;

    v_withdraw_drain := LEAST(v_amount_abs, GREATEST(v_cached_withdraw, 0));
    v_float_drain := LEAST(GREATEST(v_amount_abs - v_withdraw_drain, 0), GREATEST(v_cached_float, 0));

    PERFORM set_config('wallet.sync_authorized', 'true', true);
    UPDATE public.wallets
       SET withdrawable_balance = GREATEST(0, v_cached_withdraw - v_withdraw_drain),
           float_balance        = GREATEST(0, v_cached_float - v_float_drain),
           balance              = GREATEST(0, v_cached_balance - v_amount_abs),
           updated_at           = now()
     WHERE user_id = p_user_id;

  ELSE
    v_direction := 'release';

    v_txn_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', p_user_id,
          'amount', v_amount_abs,
          'direction', 'cash_in',
          'category', 'system_balance_correction',
          'ledger_scope', 'wallet',
          'classification', 'admin_correction',
          'source_table', 'wallet_reconciliation',
          'description', 'Ledger reconciliation release — ' || p_reason,
          'reference_id', 'ledger_reconcile_' || p_user_id::text || '_' || extract(epoch from now())::bigint::text
        ),
        jsonb_build_object(
          'user_id', NULL,
          'amount', v_amount_abs,
          'direction', 'cash_out',
          'category', 'system_balance_correction',
          'ledger_scope', 'platform',
          'classification', 'admin_correction',
          'source_table', 'wallet_reconciliation',
          'description', 'Ledger reconciliation release platform leg for user ' || p_user_id::text,
          'reference_id', 'ledger_reconcile_' || p_user_id::text || '_' || extract(epoch from now())::bigint::text
        )
      ),
      'ledger-reconcile-' || p_user_id::text || '-' || md5(v_cached_balance::text || ':' || v_ledger_net::text || ':' || v_amount_abs::text || ':' || current_date::text),
      true
    );

    SELECT id INTO v_correction_id
    FROM public.general_ledger
    WHERE transaction_group_id = v_txn_group
      AND user_id = p_user_id
      AND ledger_scope = 'wallet'
    ORDER BY created_at ASC
    LIMIT 1;

    PERFORM set_config('wallet.sync_authorized', 'true', true);
    UPDATE public.wallets
       SET withdrawable_balance = GREATEST(0, v_cached_withdraw + v_amount_abs),
           balance              = GREATEST(0, v_cached_balance + v_amount_abs),
           updated_at           = now()
     WHERE user_id = p_user_id;
  END IF;

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
      'target_balance',     v_target_balance,
      'delta',              v_delta,
      'direction',          v_direction,
      'transaction_group',  v_txn_group,
      'correction_id',      v_correction_id
    )
  );

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES (
      'wallet.reconciled_from_ledger',
      p_user_id,
      jsonb_build_object(
        'reconciled_by', v_caller,
        'delta',         v_delta,
        'target_balance', v_target_balance,
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
    'target_balance', v_target_balance,
    'delta',          v_delta,
    'direction',      v_direction,
    'transaction_group', v_txn_group
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_wallet_from_ledger(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_wallet_from_ledger(uuid, text) TO authenticated;
