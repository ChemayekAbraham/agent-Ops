-- 2026-10-18 (doc 247, step 19): v_agent_daily_eligibility (110 rows: per-agent expected/paid today, coverage) and v_tenant_daily_eligibility
-- (950 rows: every active plan with tenant, agent, landlord, balances) were owner-rights views selectable by any signed-in user.
-- They feed ~25 SECURITY DEFINER functions, including the trigger tr_enforce_agent_daily_eligibility on rent_requests (which reads the view for
-- NEW.agent_id and LETS THE ROW THROUGH when it finds none) and recalculate_credit_limit. Gating on the caller's auth.uid() would make those functions
-- see zero rows for non-staff callers (agent registering a tenant, tenant, system) and silently open the 50% eligibility block.
-- So the gate applies only to DIRECT reads: inside an owner-rights function current_user is the function owner, via PostgREST it is 'authenticated'.
--   v_agent_daily_eligibility: current_user <> 'authenticated' OR own row (agent_id = auth.uid()) OR can_view_staff_reports
--   v_tenant_daily_eligibility: current_user <> 'authenticated' OR tenant_id = auth.uid() OR agent_id = auth.uid() OR can_view_staff_reports
-- Direct browser readers: staff dashboards (DailyPaymentTracker, MissedDaysTracker, AgentMonitoring, RentAnalysis, call-centre hooks, CFO receivables),
-- AgentDailyOverviewReportButton (staff), WithdrawFlow and SendMoneyDialog (agent's own row).
-- Already applied to production 2026-10-18.
do $$
declare d text;
begin
  d := regexp_replace(pg_get_viewdef('public.v_agent_daily_eligibility'::regclass), ';\s*$', '');
  execute 'create or replace view public.v_agent_daily_eligibility as select * from (' || d || ') q where current_user <> ''authenticated'' or q.agent_id = auth.uid() or public.can_view_staff_reports(auth.uid())';
  d := regexp_replace(pg_get_viewdef('public.v_tenant_daily_eligibility'::regclass), ';\s*$', '');
  execute 'create or replace view public.v_tenant_daily_eligibility as select * from (' || d || ') q where current_user <> ''authenticated'' or q.tenant_id = auth.uid() or q.agent_id = auth.uid() or public.can_view_staff_reports(auth.uid())';
end $$;
