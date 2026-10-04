-- Fixes a Row-Level Security gap that blocked every merchant (cash-out) agent
-- from ever seeing an unclaimed withdrawal in their Pending Queue, regardless
-- of their cashout_agents.config permissions. The prior SELECT policy only
-- granted visibility once a row was already assigned_cashout_agent_id /
-- dispatch_claimed_by / processed_by = the agent themselves — a genuinely
-- fresh, untouched withdrawal_requests row (assigned_cashout_agent_id IS NULL)
-- matched none of those clauses for any regular agent, so the queue appeared
-- permanently empty no matter what channels/categories were enabled for them.
--
-- Applied directly to production on 2026-09-11 during a rush-hour outage
-- (agents unable to see/process pending partner ROI bank payouts); this
-- migration file captures that change for the repo.

ALTER POLICY "Owners staff and assigned merchant agents can view withdrawals"
ON public.withdrawal_requests
USING (
  (user_id = auth.uid())
  OR is_withdrawal_staff(auth.uid())
  OR (
    is_active_cashout_agent(auth.uid())
    AND (
      assigned_cashout_agent_id IS NULL
      OR assigned_cashout_agent_id = (
        SELECT ca.id FROM public.cashout_agents ca WHERE ca.agent_id = auth.uid() LIMIT 1
      )
      OR dispatch_claimed_by = auth.uid()
      OR processed_by = auth.uid()
    )
  )
);
