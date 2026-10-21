-- 2026-10-18 (doc 247, step 18): v_merchant_oop_evidence (every merchant desk's out-of-pocket claims: recipient names/phones, payout TIDs,
-- float position at payout; 3,857 rows) was an owner-rights view selectable by any signed-in user.
-- Readers: MerchantDebtSettlementDialog via useMerchantSettlementDebts (finance staff), get_merchant_out_of_pocket_summary (own desk, or cfo / financial_ops /
-- super_admin / is_ops_role for another desk) and settle_merchant_out_of_pocket (re-derives evidence itself); approve-withdrawal edge uses the service role.
-- Gate: own rows (agent_id = auth.uid()), or can_view_finance_reports, or is_ops_role, or service role (via can_view_finance_reports).
-- merchant_float_position_at stays closed to signed-in users: the view runs it as an owner-rights function without needing the caller's EXECUTE (verified).
-- Already applied to production 2026-10-18.
do $$
declare d text;
begin
  d := regexp_replace(pg_get_viewdef('public.v_merchant_oop_evidence'::regclass), ';\s*$', '');
  execute 'create or replace view public.v_merchant_oop_evidence as select * from (' || d || ') q where q.agent_id = auth.uid() or public.can_view_finance_reports(auth.uid()) or public.is_ops_role(auth.uid())';
end $$;
