
-- ============================================================
-- PHASE 1: LEDGER-TRUTH RECONCILIATION
-- ============================================================

-- 1. View exposing cache-vs-ledger drift per wallet
CREATE OR REPLACE VIEW public.wallet_ledger_truth_view AS
WITH ledger_truth AS (
  SELECT
    user_id,
    SUM(CASE WHEN direction = 'cash_in'  THEN amount
             WHEN direction = 'cash_out' THEN -amount
             ELSE 0 END) AS ledger_net
  FROM public.general_ledger
  WHERE ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production')
  GROUP BY user_id
)
SELECT
  w.user_id,
  COALESCE(p.full_name, '(unknown)')          AS full_name,
  w.balance                                    AS cached_balance,
  w.withdrawable_balance                       AS cached_withdrawable,
  w.float_balance                              AS cached_float,
  w.advance_balance                            AS cached_advance,
  COALESCE(lt.ledger_net, 0)                   AS ledger_net,
  (w.balance - COALESCE(lt.ledger_net, 0))     AS drift_amount,
  CASE
    WHEN ROUND(w.balance) = ROUND(COALESCE(lt.ledger_net, 0)) THEN 'in_sync'
    WHEN w.balance > COALESCE(lt.ledger_net, 0)               THEN 'phantom_air'
    ELSE 'hidden_owed'
  END                                           AS drift_direction,
  w.updated_at
FROM public.wallets w
LEFT JOIN ledger_truth lt ON lt.user_id = w.user_id
LEFT JOIN public.profiles p ON p.id = w.user_id;

GRANT SELECT ON public.wallet_ledger_truth_view TO authenticated;

-- 2. RPC: reconcile a single wallet to the ledger truth
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
  -- Authorization: CFO, super_admin, or service_role
  IF v_caller IS NULL THEN
    -- service_role calling directly (cron / one-off) is allowed
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

  -- Read current cache snapshot
  SELECT COALESCE(balance,0), COALESCE(withdrawable_balance,0),
         COALESCE(float_balance,0), COALESCE(advance_balance,0)
    INTO v_cached_balance, v_cached_withdraw, v_cached_float, v_cached_advance
  FROM public.wallets
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconcile_wallet_from_ledger: wallet not found for user %', p_user_id;
  END IF;

  -- Compute ledger truth (production wallet scope, all-time)
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

  -- Resolve a "platform" counterparty UUID. Use the first super_admin as the
  -- counterparty (or fall back to caller). The platform leg is informational
  -- only: it keeps the double-entry balanced inside general_ledger.
  SELECT user_id INTO v_platform_id
  FROM public.user_roles
  WHERE role::text = 'super_admin'
  ORDER BY created_at NULLS LAST
  LIMIT 1;
  v_platform_id := COALESCE(v_platform_id, v_caller);

  v_amount_abs := abs(v_delta);

  -- Authorize wallet write for the duration of this transaction
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  IF v_delta > 0 THEN
    -- Cache > ledger → phantom air. Reduce cache; post wallet cash_out + platform cash_in.
    v_direction := 'writedown';

    -- Post wallet leg (cash_out from user)
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, description,
      ledger_scope, classification, transaction_group_id, transaction_date
    ) VALUES (
      p_user_id, v_amount_abs, 'cash_out', 'system_balance_correction',
      'Ledger reconciliation writedown — ' || p_reason,
      'wallet', 'admin_correction', v_txn_group, now()
    ) RETURNING id INTO v_correction_id;

    -- Post platform leg (cash_in to platform)
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, description,
      ledger_scope, classification, transaction_group_id, transaction_date
    ) VALUES (
      v_platform_id, v_amount_abs, 'cash_in', 'system_balance_correction',
      'Ledger reconciliation writedown (platform leg) for user ' || p_user_id::text,
      'platform', 'admin_correction', v_txn_group, now()
    );

    -- Apply the wallet bucket reduction. Drain withdrawable first, then float.
    UPDATE public.wallets
       SET withdrawable_balance = GREATEST(0, withdrawable_balance - LEAST(v_amount_abs, withdrawable_balance)),
           float_balance        = float_balance
                                  - GREATEST(0, v_amount_abs - LEAST(v_amount_abs, withdrawable_balance)),
           balance              = GREATEST(0, balance - v_amount_abs),
           updated_at           = now()
     WHERE user_id = p_user_id;

  ELSE
    -- Cache < ledger → hidden owed. Credit cache; post wallet cash_in + platform cash_out.
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

    -- Credit the user's withdrawable bucket
    UPDATE public.wallets
       SET withdrawable_balance = withdrawable_balance + v_amount_abs,
           balance              = balance + v_amount_abs,
           updated_at           = now()
     WHERE user_id = p_user_id;
  END IF;

  -- Audit log
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, reason, metadata
  ) VALUES (
    v_caller, 'wallet_full_reconciliation', 'wallets', p_user_id, p_reason,
    jsonb_build_object(
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

  -- System event (fire-and-forget; don't fail the reconciliation if events table is missing)
  BEGIN
    INSERT INTO public.system_events (event_type, user_id, payload)
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

GRANT EXECUTE ON FUNCTION public.reconcile_wallet_from_ledger(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.reconcile_wallet_from_ledger(uuid, text) IS
  'Phase 1 ledger-truth reconciliation. Posts a balanced double-entry correction to bring cached wallet balance to ledger truth. CFO/super_admin/manager only. Reason ≥10 chars.';

COMMENT ON VIEW public.wallet_ledger_truth_view IS
  'Per-user diff between cached wallet balance and authoritative ledger net (production wallet scope). Drift directions: in_sync | phantom_air | hidden_owed.';
