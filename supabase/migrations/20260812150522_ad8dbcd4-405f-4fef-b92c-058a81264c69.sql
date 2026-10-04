CREATE OR REPLACE FUNCTION public.resolve_payout_merchant_identity(p_actor_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'actor_id', p_actor_id,
    'is_merchant', ca.id IS NOT NULL,
    'merchant_agent_id', ca.id,
    'agent_id', ca.agent_id,
    'resolved_from', 'cashout_agents.is_active',
    'resolved_at', now()
  )
  FROM (SELECT 1) one
  LEFT JOIN public.cashout_agents ca
    ON ca.agent_id = p_actor_id AND ca.is_active IS TRUE
  LIMIT 1;
$fn$;

GRANT EXECUTE ON FUNCTION public.resolve_payout_merchant_identity(uuid) TO authenticated, service_role;