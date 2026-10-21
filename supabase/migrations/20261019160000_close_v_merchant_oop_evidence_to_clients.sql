-- 2026-10-19 (doc 247, step 25, final): v_merchant_oop_evidence is no longer readable by signed-in users or anon.
-- The only browser reader (useMerchantSettlementDebts in useMerchantFloat.ts) now calls merchant_oop_debts_for_settlement (published; the API log shows it called,
-- including a successful 200). Only the owner-rights functions merchant_oop_debts_for_settlement, settle_merchant_out_of_pocket and
-- get_merchant_out_of_pocket_summary read the view, plus the service role. Applied to production 2026-10-19.
revoke all on public.v_merchant_oop_evidence from anon, public;
revoke all on public.v_merchant_oop_evidence from authenticated;
grant select on public.v_merchant_oop_evidence to service_role;
