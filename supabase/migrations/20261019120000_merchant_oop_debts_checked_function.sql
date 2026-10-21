-- 2026-10-19 (doc 247, step 25): checked replacement for the direct read of the owner-rights view v_merchant_oop_evidence.
-- Only reader in the browser: useMerchantSettlementDebts (src/hooks/useMerchantFloat.ts, MerchantDebtSettlementDialog). Owner-rights DB functions
-- (settle_merchant_out_of_pocket, get_merchant_out_of_pocket_summary) keep reading the view as the owner.
-- merchant_oop_debts_for_settlement(p_limit): open claims (pending_reimbursement / needs_review, not yet reimbursed), newest first, capped at 2,000.
-- The view's own gate (own desk, finance staff or ops, evaluated with the caller's auth.uid()) still applies inside this owner-rights call.
-- Additive: nothing changes until the screen switches; then revoke select on the view from authenticated (doc 247 step 25).
-- Already applied to production 2026-10-19.
create or replace function public.merchant_oop_debts_for_settlement(p_limit integer default 2000)
 returns setof public.v_merchant_oop_evidence
 language plpgsql stable security definer set search_path = public
as $f$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' and auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return query
    select e.* from public.v_merchant_oop_evidence e
     where e.status in ('pending_reimbursement', 'needs_review') and e.reimbursed_at is null
     order by e.created_at desc
     limit least(greatest(coalesce(p_limit, 2000), 1), 2000);
end $f$;
revoke all on function public.merchant_oop_debts_for_settlement(integer) from public, anon;
grant execute on function public.merchant_oop_debts_for_settlement(integer) to authenticated, service_role;
