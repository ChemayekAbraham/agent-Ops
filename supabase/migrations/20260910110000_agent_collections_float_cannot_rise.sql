-- An agent's float can never rise when they settle a tenant's rent.
--
-- WHY THIS EXISTS
-- On 2026-09-10 a collection RPC was deployed straight to production with both
-- ledger legs reversed. For 1h52m every collection CREDITED the agent's float
-- instead of debiting it, still paid 10% commission, and still cleared the
-- tenant's debt: 16 collections, 3 agents, 6,064,036 wrongly credited.
--
-- Nothing stopped it. The guard that should have caught it had been edited in
-- the same deployment to expect the inverted direction, and the repo never saw
-- either change - so no review, no build guard and no migration could have
-- intervened.
--
-- This constraint is the one defence that does not depend on any of that. An
-- agent spending their own float to pay a tenant's rent cannot finish holding
-- MORE float than they started with. That is arithmetic, not policy, so it
-- holds no matter which function writes the row, who deployed it, or what the
-- guards happen to believe this week.
--
-- Evidence it is safe: across 11,207 agent_float collections in the table,
-- 11,168 show float falling and 39 show it unchanged. Every single row where
-- float rose belongs to this incident. Zero legitimate rows violate it.
--
-- Rows where float_before/float_after are NULL, and non-agent_float channels
-- (tenant_deposit_auto, where the agent's float is untouched), are unaffected.
--
-- NOT VALID: the 16 reversed incident rows stay in place and readable as
-- history. The constraint binds every row written from now on.
--
-- Verified after applying: an UPDATE setting float_after = float_before + 999,
-- the exact shape of the incident, is rejected with a check_violation.

ALTER TABLE public.agent_collections
  ADD CONSTRAINT agent_collections_float_cannot_rise
  CHECK (
    collection_channel IS DISTINCT FROM 'agent_float'
    OR float_before IS NULL OR float_after IS NULL
    OR float_after <= float_before
  ) NOT VALID;

COMMENT ON CONSTRAINT agent_collections_float_cannot_rise ON public.agent_collections IS
  'An agent spending float to settle rent can never end with more float than they started with. Added 2026-09-10 after an inverted ledger-direction deployment credited 6,064,036 across 16 collections. Arithmetic, not policy - it holds regardless of which RPC writes the row or what the guards permit.';
