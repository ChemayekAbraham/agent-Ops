SELECT set_config('wallet.sync_authorized','true',true);
UPDATE public.wallet_balances_projection
SET float_balance = float_balance + 13000,
    total_visible = withdrawable + float_balance + 13000 - pending_holds - restricted_held,
    ledger_version = ledger_version + 1,
    updated_at = now()
WHERE user_id = '47e6c48c-9e53-451c-9a23-f0b58fe48b47';