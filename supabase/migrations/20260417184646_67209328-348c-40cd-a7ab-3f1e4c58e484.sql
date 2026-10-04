-- Backfill: mark pending sub-agents as verified, and pending sub-agent
-- invites as activated. Temporarily disable the bonus trigger because it
-- references a ledger category not in the strict allowlist (separate issue).

ALTER TABLE public.agent_subagents DISABLE TRIGGER trg_award_subagent_commission;

UPDATE public.agent_subagents
SET status = 'verified',
    verified_at = COALESCE(verified_at, now())
WHERE status = 'pending';

ALTER TABLE public.agent_subagents ENABLE TRIGGER trg_award_subagent_commission;

-- Mark legacy pending sub-agent invites as activated so the
-- "Pending" invite UI on the agent dashboard clears out.
UPDATE public.supporter_invites
SET status = 'activated',
    activated_at = COALESCE(activated_at, now())
WHERE role = 'agent'
  AND status = 'pending';