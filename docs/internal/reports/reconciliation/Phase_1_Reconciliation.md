# Phase 1: Mass Ledger Reconciliation & Neutralization

## Context: The Enormous Debt
Historically, the `general_ledger` suffered from severe "phantom debt." Manual legacy operations (such as high-frequency 500 UGX `legacy_real` agent commissions) aggressively pulled `cash_out` without bounds, driving user balances into enormous negative deficits. Because these transactions bypassed the core `apply_wallet_movement` routing logic, the frontend `wallets` cache became completely decoupled from the actual ledger. 

This resulted in situations where legitimate deposits were entirely swallowed by invisible phantom debts, leading to widespread "insufficient funds" errors on the frontend.

## Objective
To stop the bleeding and restore mathematical parity between the ledger and the frontend wallets, we must execute a **Mass Reconciliation**. 

Instead of destructively deleting rows (which violates audit integrity), this script dynamically calculates the true deficit for every single user. If a user is in negative debt, it forces a strict `system_balance_correction` via `create_ledger_transaction`, absorbing the exact deficit into the `platform` scope to reset the user's true ledger balance to `0 UGX`. Finally, it forcefully overwrites the `wallets` cache for every user to instantly sync the frontend with the newly cleaned ledger.

## Execution
we can't run the following SQL script directly in our Supabase SQL Editor even applying it as a migration via `supabase db push`.
so we can force lovable to run this as a prompt.

```sql
-- Phase 1: Mass Ledger Reconciliation & Neutralization
-- This script safely zeroes out all phantom debt caused by legacy operations 
-- without deleting history, using 'system_balance_correction' against the platform books.

DO $$
DECLARE
    r RECORD;
    v_ledger_net BIGINT;
    v_deficit BIGINT;
    v_txn_id UUID;
    v_batch_count INT := 0;
BEGIN
    RAISE NOTICE 'Starting Mass Ledger Reconciliation...';

    FOR r IN SELECT id, phone, full_name FROM public.profiles LOOP
        -- Calculate TRUE ledger net
        SELECT COALESCE(SUM(
            CASE 
                WHEN direction = 'cash_in' THEN amount 
                WHEN direction = 'cash_out' THEN -amount 
                ELSE 0 
            END
        ), 0) INTO v_ledger_net
        FROM public.general_ledger
        WHERE user_id = r.id AND ledger_scope = 'wallet' AND classification = 'production';

        -- If user has phantom debt (negative balance)
        IF v_ledger_net < 0 THEN
            v_deficit := ABS(v_ledger_net);
            
            -- Inject correction using create_ledger_transaction
            v_txn_id := public.create_ledger_transaction(
                entries := jsonb_build_array(
                    jsonb_build_object(
                        'amount', v_deficit,
                        'currency', 'UGX',
                        'direction', 'cash_in',
                        'ledger_scope', 'wallet',
                        'user_id', r.id,
                        'category', 'system_balance_correction',
                        'description', 'Mass reconciliation: Neutralizing ' || v_deficit::text || ' UGX phantom debt'
                    ),
                    jsonb_build_object(
                        'amount', v_deficit,
                        'currency', 'UGX',
                        'direction', 'cash_out',
                        'ledger_scope', 'platform',
                        'category', 'system_balance_correction',
                        'description', 'Mass reconciliation: Absorbing phantom debt for user ' || COALESCE(r.phone, 'Unknown')
                    )
                ),
                skip_balance_check := true
            );
            
            v_ledger_net := 0;
            v_batch_count := v_batch_count + 1;
            RAISE NOTICE 'Neutralized % UGX for user % (Txn: %)', v_deficit, COALESCE(r.phone, 'Unknown'), v_txn_id;
        END IF;

        -- Force cache sync for EVERY user (even if not negative, to ensure accuracy)
        UPDATE public.wallets
        SET 
            balance = v_ledger_net,
            withdrawable_balance = v_ledger_net,
            float_balance = 0,
            advance_balance = 0,
            updated_at = NOW()
        WHERE user_id = r.id;
    END LOOP;

    RAISE NOTICE 'Mass Reconciliation Complete! Neutralized % negative wallets.', v_batch_count;
END $$;
```
