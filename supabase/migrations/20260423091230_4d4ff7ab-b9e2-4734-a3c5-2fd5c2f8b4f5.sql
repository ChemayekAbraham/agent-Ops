-- =============================================================================
-- PHANTOM WALLET BACK-FILL MIGRATION (idempotent)
-- Reconciles wallet balances with general_ledger by inserting balanced
-- admin_correction entries. Wallet bucket fields are NOT modified.
-- =============================================================================

DO $$
DECLARE
  v_phantom record;
  v_group_id uuid;
  v_now timestamptz := now();
  v_count int := 0;
  v_total numeric := 0;
  v_breakdown jsonb := '{}'::jsonb;
  v_category text;
  v_wallet_amt numeric;
  v_float_amt numeric;
  v_commission_amt numeric;
  v_user_roles text[];
  v_is_supporter boolean;
  v_is_agent boolean;
  v_full_name text;
BEGIN
  -- Authorize raw ledger inserts and suppress bucket router for this transaction
  PERFORM set_config('ledger.authorized', 'true', true);
  ALTER TABLE public.general_ledger DISABLE TRIGGER general_ledger_route_buckets;

  FOR v_phantom IN
    WITH ledger_net AS (
      SELECT user_id,
             SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) AS net
      FROM public.general_ledger
      WHERE ledger_scope='wallet'
        AND user_id IS NOT NULL
        AND classification IN ('production','admin_correction')
      GROUP BY user_id
    )
    SELECT w.user_id,
           w.balance,
           COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
           COALESCE(w.float_balance, 0) AS float_balance,
           COALESCE(l.net, 0) AS ledger_net,
           w.balance - COALESCE(l.net, 0) AS gap
    FROM public.wallets w
    LEFT JOIN ledger_net l USING(user_id)
    WHERE w.balance > COALESCE(l.net, 0)
      AND w.balance - COALESCE(l.net, 0) >= 1
  LOOP
    -- Guard: skip if a back-fill entry was already written for this user
    IF EXISTS (
      SELECT 1 FROM public.general_ledger
      WHERE user_id = v_phantom.user_id
        AND classification = 'admin_correction'
        AND source_table = 'phantom_wallet_backfill'
    ) THEN
      CONTINUE;
    END IF;

    -- Determine role-based category routing
    SELECT array_agg(DISTINCT role::text) INTO v_user_roles
    FROM public.user_roles WHERE user_id = v_phantom.user_id;

    SELECT full_name INTO v_full_name FROM public.profiles WHERE id = v_phantom.user_id;

    v_is_agent := v_user_roles && ARRAY['agent'];
    v_is_supporter := v_user_roles && ARRAY['supporter'] AND NOT v_is_agent;

    v_group_id := gen_random_uuid();

    -- Decide split: if agent has both float + withdrawable balances, split entries
    IF v_is_agent AND v_phantom.float_balance > 0 AND v_phantom.withdrawable_balance > 0 THEN
      -- Mixed agent: split into float and commission components proportionally to gap
      v_float_amt := LEAST(v_phantom.float_balance, v_phantom.gap);
      v_commission_amt := v_phantom.gap - v_float_amt;

      IF v_float_amt > 0 THEN
        INSERT INTO public.general_ledger
          (user_id, amount, direction, category, ledger_scope, description, currency,
           source_table, transaction_date, classification, transaction_group_id, account)
        VALUES
          (v_phantom.user_id, v_float_amt, 'cash_in', 'agent_float_deposit', 'wallet',
           'Phantom wallet back-fill — opening equity (mixed_agent: float)',
           'UGX', 'phantom_wallet_backfill', v_now, 'admin_correction', v_group_id,
           'wallet:'||v_phantom.user_id::text);

        INSERT INTO public.general_ledger
          (amount, direction, category, ledger_scope, description, currency,
           source_table, transaction_date, classification, transaction_group_id, account)
        VALUES
          (v_float_amt, 'cash_out', 'agent_float_deposit', 'platform',
           'Phantom wallet back-fill — opening equity (mixed_agent: float)',
           'UGX', 'phantom_wallet_backfill', v_now, 'admin_correction', v_group_id,
           'platform:opening_equity');
      END IF;

      IF v_commission_amt > 0 THEN
        INSERT INTO public.general_ledger
          (user_id, amount, direction, category, ledger_scope, description, currency,
           source_table, transaction_date, classification, transaction_group_id, account)
        VALUES
          (v_phantom.user_id, v_commission_amt, 'cash_in', 'agent_commission_earned', 'wallet',
           'Phantom wallet back-fill — opening equity (mixed_agent: commission)',
           'UGX', 'phantom_wallet_backfill', v_now, 'admin_correction', v_group_id,
           'wallet:'||v_phantom.user_id::text);

        INSERT INTO public.general_ledger
          (amount, direction, category, ledger_scope, description, currency,
           source_table, transaction_date, classification, transaction_group_id, account)
        VALUES
          (v_commission_amt, 'cash_out', 'agent_commission_earned', 'platform',
           'Phantom wallet back-fill — opening equity (mixed_agent: commission)',
           'UGX', 'phantom_wallet_backfill', v_now, 'admin_correction', v_group_id,
           'platform:opening_equity');
      END IF;

      v_category := 'mixed_agent';

    ELSE
      -- Single category
      IF v_is_agent AND v_phantom.float_balance > 0 AND v_phantom.withdrawable_balance = 0 THEN
        v_category := 'agent_float_deposit';
      ELSIF v_is_agent THEN
        v_category := 'agent_commission_earned';
      ELSIF v_is_supporter THEN
        v_category := 'roi_wallet_credit';
      ELSIF v_user_roles IS NULL OR array_length(v_user_roles, 1) IS NULL THEN
        v_category := 'system_balance_correction';
      ELSE
        v_category := 'wallet_deposit';
      END IF;

      INSERT INTO public.general_ledger
        (user_id, amount, direction, category, ledger_scope, description, currency,
         source_table, transaction_date, classification, transaction_group_id, account)
      VALUES
        (v_phantom.user_id, v_phantom.gap, 'cash_in', v_category, 'wallet',
         format('Phantom wallet back-fill — opening equity (%s) for %s',
                v_category, COALESCE(v_full_name, v_phantom.user_id::text)),
         'UGX', 'phantom_wallet_backfill', v_now, 'admin_correction', v_group_id,
         'wallet:'||v_phantom.user_id::text);

      INSERT INTO public.general_ledger
        (amount, direction, category, ledger_scope, description, currency,
         source_table, transaction_date, classification, transaction_group_id, account)
      VALUES
        (v_phantom.gap,
         CASE WHEN v_category IN ('roi_wallet_credit') THEN 'cash_out' ELSE 'cash_out' END,
         v_category, 'platform',
         format('Phantom wallet back-fill — opening equity (%s) for %s',
                v_category, COALESCE(v_full_name, v_phantom.user_id::text)),
         'UGX', 'phantom_wallet_backfill', v_now, 'admin_correction', v_group_id,
         'platform:opening_equity');
    END IF;

    v_count := v_count + 1;
    v_total := v_total + v_phantom.gap;
    v_breakdown := jsonb_set(
      v_breakdown,
      ARRAY[v_category],
      to_jsonb(COALESCE((v_breakdown ->> v_category)::numeric, 0) + v_phantom.gap)
    );
  END LOOP;

  -- Re-enable bucket router and clear authorization
  ALTER TABLE public.general_ledger ENABLE TRIGGER general_ledger_route_buckets;
  PERFORM set_config('ledger.authorized', 'false', true);

  -- Audit log
  INSERT INTO public.audit_logs
    (action_type, table_name, record_id, metadata)
  VALUES
    ('phantom_wallet_backfill', 'wallets', NULL,
     jsonb_build_object(
       'wallet_count', v_count,
       'total_ugx', v_total,
       'breakdown', v_breakdown,
       'executed_at', v_now,
       'idempotent', true
     ));

  RAISE NOTICE 'Back-filled % phantom wallets, total UGX %; breakdown: %',
    v_count, v_total, v_breakdown;
END $$;