-- 2026-10-18 (doc 247, step 20, stage 2 of wallets): READ gate on `wallets` and `v_user_wallet_strict`.
-- Both are owner-rights views over every user's balances (97,526 wallets): any signed-in user could read anyone's balance, withdrawable, float and advance.
-- Owner-rights functions (check_transfer_recipient_eligibility, ops_get_wallet_buckets, the trigger functions behind wallets, ...) read these views, so the gate
-- applies to DIRECT reads only: inside an owner-rights function current_user is the function owner, via PostgREST it is 'authenticated'.
-- Direct-read rule: own wallet, or the caller's wallet "network" (agent_wallet_network_ids), or staff (can_view_staff_reports).
-- Network = the caller, profiles they manage / referred (managing_agent_id, referrer_id, merchant_agent_referrer_id), tenants on a plan they hold
-- (rent_requests.agent_id / assigned_agent_id), their sub-agents (agent_subagents.parent_agent_id), and active proxy beneficiaries (proxy_agent_assignments).
-- Built as a set (hashed sub-plan, evaluated once per query) and the staff check as an init-plan: a per-row function version timed out on full scans.
-- Screens audited (49 files): own-wallet readers, staff panels (finance, COO, CFO, ops, call centre, agent-ops, manager), agent readers of sub-agents
-- (SubAgentStatusBoard, SubAgentAnalytics), tenants (TenantProfileView, fetchAgentWalletData) and managed partners. AgentAngelPoolInvestDialog's balance for a
-- searched user now shows 0 unless that user is in the agent's network (that read was an any-user balance lookup).
-- Edge functions read wallets with the service role (or, for mcp, the caller's own row).
-- Apply ONCE to the original view definitions (it wraps pg_get_viewdef; re-running would double-wrap). Already applied to production 2026-10-18.
create or replace function public.agent_wallet_network_ids(_agent uuid)
 returns setof uuid language sql stable security definer set search_path to 'public'
as $f$
  select _agent where _agent is not null
  union select p.id from public.profiles p where _agent is not null and (p.managing_agent_id = _agent or p.referrer_id = _agent or p.merchant_agent_referrer_id = _agent)
  union select rr.tenant_id from public.rent_requests rr where _agent is not null and rr.tenant_id is not null and (rr.agent_id = _agent or rr.assigned_agent_id = _agent)
  union select s.sub_agent_id from public.agent_subagents s where _agent is not null and s.parent_agent_id = _agent and s.sub_agent_id is not null
  union select a.beneficiary_id from public.proxy_agent_assignments a where _agent is not null and a.agent_id = _agent and coalesce(a.is_active, true) and a.beneficiary_id is not null;
$f$;
revoke all on function public.agent_wallet_network_ids(uuid) from public, anon;
grant execute on function public.agent_wallet_network_ids(uuid) to authenticated, service_role;

do $$
declare d text; v text;
begin
  foreach v in array array['wallets','v_user_wallet_strict'] loop
    d := regexp_replace(pg_get_viewdef(('public.'||v)::regclass), ';\s*$', '');
    execute format('create or replace view public.%I as select * from (%s) q where current_user <> ''authenticated'' or q.user_id in (select public.agent_wallet_network_ids(auth.uid())) or (select public.can_view_staff_reports(auth.uid()))', v, d);
  end loop;
end $$;
