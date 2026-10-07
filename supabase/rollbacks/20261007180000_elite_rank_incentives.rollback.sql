-- Rollback for 20261007180000_elite_rank_incentives.sql
-- Stops future payments and restores the whitelist-only commission predicate. Money already posted stays in general_ledger
-- (find it with idempotency_key LIKE 'elite_subagent_tenant_bounty:%' or 'elite_second_degree_bonus:%'); reverse it through the normal ledger reversal path, never by deleting rows.
DROP TRIGGER IF EXISTS trg_elite_subagent_tenant_bounty ON public.rent_requests;
DROP TRIGGER IF EXISTS trg_elite_second_degree_bonus ON public.referrals;
DROP FUNCTION IF EXISTS public.credit_elite_subagent_tenant_bounty();
DROP FUNCTION IF EXISTS public.credit_elite_second_degree_bonus();

CREATE OR REPLACE FUNCTION public.is_subagent_commission_whitelisted(p_sub_agent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_subagent_commission_whitelist w
    WHERE w.sub_agent_id = p_sub_agent_id AND w.whitelisted = true
  );
$$;

DROP FUNCTION IF EXISTS public.elite_incentive_max_rank();
