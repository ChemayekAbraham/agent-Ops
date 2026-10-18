-- 2026-10-18 (doc 247, step 14): nine owner-rights views that no browser or edge-function code reads, still selectable by any signed-in user.
--
-- v_payables_lines, v_receivables_lines, v_merchant_payout_queue, v_rent_plan_schedule, v_crm_call_audience, v_crm_call_section,
-- v_crm_person_roles, v_landlord_ops_status, v_tlb_tenant_base: src/ mentions are comments only and supabase/functions has no reference.
-- They run with their owner's rights, so any logged-in account could read company-wide figures. SELECT is now limited to service_role;
-- the owner keeps access, so owner-rights database functions and the owner-rights view v_rent_plan_expired_owing (reads v_rent_plan_schedule) still work.
--
-- Left open on purpose: v_tenant_ops_tenant_base (read by the security_invoker view v_cc_call_queue, which needs the caller's SELECT).
-- Restore for one view: grant select on public.<view> to authenticated;
--
-- Already applied to production 2026-10-18.
do $$
declare n text;
begin
  foreach n in array array['v_payables_lines','v_receivables_lines','v_merchant_payout_queue','v_rent_plan_schedule','v_crm_call_audience',
                           'v_crm_call_section','v_crm_person_roles','v_landlord_ops_status','v_tlb_tenant_base'] loop
    execute format('revoke all on public.%I from anon, authenticated, public', n);
    execute format('grant select on public.%I to service_role', n);
  end loop;
end $$;
