-- 2026-10-17 (doc 247, step 3b): six owner-rights functions that only edge functions call, and always through a SERVICE-ROLE client
-- (approve-withdrawal `admin`, batch-process-financials, delete-user `supabaseAdmin`, restore-archived-account `admin`), were still
-- executable by anon and authenticated with no caller check in the body. Closed to service_role only. Already applied to production.
-- Needs the helper _fn_lockdown.run from migration 20261017140000. Restore one: grant execute on function <signature> to authenticated;
select * from _fn_lockdown.run(array['deduct_agent_float_for_payout','credit_merchant_payout_commission','consume_merchant_float','auto_dispatch_withdrawals','admin_purge_user_dependencies','admin_restore_auth_user'], true);
