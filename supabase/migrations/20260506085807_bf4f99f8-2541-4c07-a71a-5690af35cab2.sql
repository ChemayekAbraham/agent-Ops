
DO $$
DECLARE
    r RECORD;
    v_ledger_net BIGINT;
    v_deficit BIGINT;
    v_txn_id UUID;
    v_batch_count INT := 0;
    v_total_users INT := 0;
BEGIN
    -- Authorize direct wallet cache writes for this session only
    PERFORM set_config('wallet.sync_authorized', 'true', true);

    RAISE NOTICE 'Starting Mass Ledger Reconciliation...';

    FOR r IN SELECT id, phone, full_name FROM public.profiles LOOP
        v_total_users := v_total_users + 1;

        SELECT COALESCE(SUM(
            CASE
                WHEN direction = 'cash_in'  THEN amount
                WHEN direction = 'cash_out' THEN -amount
                ELSE 0
            END
        ), 0) INTO v_ledger_net
        FROM public.general_ledger
        WHERE user_id = r.id
          AND ledger_scope = 'wallet'
          AND classification = 'production';

        IF v_ledger_net < 0 THEN
            v_deficit := ABS(v_ledger_net);

            v_txn_id := public.create_ledger_transaction(
                entries := jsonb_build_array(
                    jsonb_build_object(
                        'amount', v_deficit,
                        'currency', 'UGX',
                        'direction', 'cash_in',
                        'ledger_scope', 'wallet',
                        'user_id', r.id,
                        'category', 'system_balance_correction',
                        'classification', 'admin_correction',
                        'description', 'Mass reconciliation: Neutralizing ' || v_deficit::text || ' UGX phantom debt'
                    ),
                    jsonb_build_object(
                        'amount', v_deficit,
                        'currency', 'UGX',
                        'direction', 'cash_out',
                        'ledger_scope', 'platform',
                        'user_id', r.id,
                        'category', 'system_balance_correction',
                        'classification', 'admin_correction',
                        'description', 'Mass reconciliation: Absorbing phantom debt for user ' || COALESCE(r.phone, 'Unknown')
                    )
                ),
                skip_balance_check := true
            );

            v_ledger_net := 0;
            v_batch_count := v_batch_count + 1;
        END IF;

        UPDATE public.wallets
        SET
            balance              = GREATEST(v_ledger_net, 0),
            withdrawable_balance = GREATEST(v_ledger_net, 0),
            float_balance        = 0,
            advance_balance      = 0,
            updated_at           = NOW()
        WHERE user_id = r.id;
    END LOOP;

    RAISE NOTICE 'Mass Reconciliation Complete. Scanned % users, neutralized % negative wallets.', v_total_users, v_batch_count;
END $$;
