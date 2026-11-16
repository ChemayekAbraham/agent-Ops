-- ROLLBACK of 20261125130000_rent_plan_fee_revenue (only on CFO instruction; roll back the batch first). Postings already made stay on the
-- ledger; the legacy_plan_fee_* mapping rows stay while such postings exist.
SELECT cron.unschedule('recognise-legacy-plan-fees-nightly');
DROP FUNCTION IF EXISTS public.recognise_legacy_plan_fees(timestamptz);
UPDATE public.ledger_account_map SET account_code = 'L7', updated_at = now()
 WHERE ledger_scope = 'platform' AND category = 'partner_returns_allocated' AND wallet_bucket IS NULL AND account_code = 'X2';
DELETE FROM public.fin_pnl_lines WHERE account_code = 'R1' AND category = 'legacy_plan_fee_revenue';
