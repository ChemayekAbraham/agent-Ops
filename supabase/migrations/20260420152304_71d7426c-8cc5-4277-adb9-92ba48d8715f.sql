-- Backfill Joshua Wanda's wallet buckets from ledger.
-- Router already routes system_balance_correction / roi_wallet_credit / general_admin_expense
-- to the withdrawable bucket, but historical trigger misses left his wallet desynced.
-- Recomputing buckets from general_ledger restores withdrawable to match ledger reality.
SELECT * FROM public.recompute_wallet_buckets('cb798acb-68bc-4b4e-a414-a3d374e030b6'::uuid);