-- Narrow the merchant "see unclaimed withdrawals" RLS clause to the open queue.
--
-- 20260911150000_allow_cashout_agents_view_unclaimed_withdrawals.sql fixed the
-- empty Merchant Payout Queue by letting any active cash-out agent SELECT rows
-- where `assigned_cashout_agent_id IS NULL`. That clause has no status filter,
-- so it also opened every HISTORICAL unassigned withdrawal to every merchant:
-- measured live 2026-09-11, ~4,190 rows (2,074 rejected, 1,705 completed, 210
-- expired, ...) back to 2026-01-20, including 575 bank account numbers plus
-- phone numbers, names and amounts. Only 21 of them were open (`pending`).
--
-- The unclaimed clause now matches exactly the queue fence every client read
-- uses (src/lib/merchantPayoutQueue.ts `applyMerchantQueueFence` /
-- `v_merchant_payout_queue`): an open queue status, not yet processed, no
-- payment reference, not suppressed by FinOps. Rows already tied to the agent
-- (claimed by / dispatched to / settled by them) stay visible exactly as before,
-- and rows claimed by another merchant were already invisible, so no queue that
-- works today can empty out because of this change.
ALTER POLICY "Owners staff and assigned merchant agents can view withdrawals"
ON public.withdrawal_requests
USING (
  (user_id = auth.uid())
  OR is_withdrawal_staff(auth.uid())
  OR (
    is_active_cashout_agent(auth.uid())
    AND (
      (
        assigned_cashout_agent_id IS NULL
        AND status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved')
        AND processed_at IS NULL
        AND fin_ops_reference IS NULL
        AND hidden_from_merchant_queue IS NOT TRUE
      )
      OR assigned_cashout_agent_id = (
        SELECT ca.id FROM public.cashout_agents ca WHERE ca.agent_id = auth.uid() LIMIT 1
      )
      OR dispatch_claimed_by = auth.uid()
      OR processed_by = auth.uid()
    )
  )
);
