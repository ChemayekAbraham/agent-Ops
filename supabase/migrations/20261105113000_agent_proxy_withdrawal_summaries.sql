-- Proxy agents can list the withdrawals they made for partners.
-- The frontend (src/lib/agentPartnerPortfolios.ts fetchAgentProxyWithdrawals) calls this RPC, but the
-- migration that defines it (20261104244000_partner_portfolio_read_scope.sql) was never applied, so the
-- proxy "Recent payouts" list failed with "Could not find the function ... in the schema cache".
-- This migration adds ONLY that read function. It does not drop any policy, add any trigger, or change any
-- grant on a table. Read-only: no payout numbers (mobile money / bank) are returned.
-- Rollback: 20261105113000_agent_proxy_withdrawal_summaries.rollback.sql

create or replace function public.agent_proxy_withdrawal_summaries()
returns table (
  id uuid,
  user_id uuid,
  linked_party uuid,
  proxy_partner_id uuid,
  agent_id uuid,
  amount numeric,
  status text,
  payout_method text,
  reason text,
  rejection_reason text,
  created_at timestamptz,
  updated_at timestamptz,
  processed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.user_id, w.linked_party, w.proxy_partner_id, w.agent_id, w.amount, w.status::text,
    w.payout_method, w.reason, w.rejection_reason, w.created_at, w.updated_at, w.processed_at
  from public.withdrawal_requests w
  where (select auth.uid()) is not null
    and (w.agent_id = (select auth.uid()) or w.initiated_by = (select auth.uid()))
    and (w.proxy_partner_id is not null or w.linked_party is not null)
  order by w.created_at desc
  limit 500
$$;

revoke all on function public.agent_proxy_withdrawal_summaries() from public, anon;
grant execute on function public.agent_proxy_withdrawal_summaries() to authenticated, service_role;
