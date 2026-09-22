# 106 — `get_agent_daily_eligibility()` has no authorization check at all

**Found 2026-09-22, investigation only — nothing changed.** Before building anything else on top
of `get_agent_daily_eligibility`, or trusting that any RPC taking a `p_agent_ids uuid[]` array is
self-scoped just because it's `SECURITY DEFINER`.

## What was asked

Building the native Android app's agent dashboard feature-by-feature. Investigated
`AgentRatingCard.tsx` / `useAgentCapacityMap.ts` ("Your Rating") as a candidate next feature.

## What was found

```sql
CREATE OR REPLACE FUNCTION public.get_agent_daily_eligibility(p_agent_ids uuid[])
RETURNS TABLE(agent_id uuid, active_count integer, expected_daily numeric, paid_today numeric, ...)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT v.agent_id, v.active_count, v.expected_daily, v.paid_today, ...
  FROM public.v_agent_daily_eligibility v
  WHERE v.agent_id = ANY (p_agent_ids);
$function$
```

There is no `auth.uid()` check anywhere in the function body — not an ownership check, not a role
check, nothing. Any authenticated user (any agent, tenant, landlord — anyone with a valid session)
can call `supabase.rpc('get_agent_daily_eligibility', { p_agent_ids: [<any uuid>] })` and read that
agent's daily collection performance: `active_count`, `expected_daily`, `paid_today`,
`paid_yesterday`, `today_pct`, `tenants_due`, `tenants_paid_today`, etc. — for any agent, not just
themselves.

Compare `get_agent_collections_coverage` (doc 104) and `agent_allocate_tenant_payment`, both of
which explicitly check `has_role(...)` or `agent_id = auth.uid() OR assigned_agent_id = auth.uid()`
before returning anything. This function has neither.

## Why this wasn't fixed here

Out of scope for the task at hand (building the native app's next dashboard feature) — this is an
existing web-app RPC, not something the native app introduces or would be calling with a
third-party `p_agent_ids` value (it would only ever pass its own signed-in user's id). Flagging it
here so whoever owns this function next knows: the exposure exists today, in production, and is not
new.

## What it's not

Not money-moving, not PII beyond performance stats (no names/phones/addresses returned). Still
worth closing — collection-rate data is competitively/personally sensitive between agents, and
"any authenticated session" is a very low bar.
