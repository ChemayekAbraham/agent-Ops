-- Hide ID-unverified open withdrawals from users who are BOTH staff and an
-- active Merchant Agent.
--
-- Problem: the withdrawal_requests SELECT policy has an unconditional staff
-- clause (`is_withdrawal_staff`), so a staff user who also runs a merchant desk
-- sees every open withdrawal in the Merchant Payout Queue, including ones from
-- customers who have not completed ID verification. Tapping Claim then fails in
-- `claim_withdrawal_verified` with "This customer has not completed ID
-- verification. This payout is not available to Merchant Agents." (that RPC has
-- no staff bypass, by design).
--
-- Fix: the staff clause no longer exposes UNCLAIMED OPEN rows that fail
-- `withdrawal_merchant_id_gate` to someone who is an active cash-out agent.
-- That is exactly the set of rows the claim RPC will refuse, so the queue now
-- matches what can be claimed.
--
-- Unchanged: pure staff (no merchant desk) still see every row; the owner
-- clause; the merchant clause (already gated); the claim RPC; the UPDATE policy.
-- Trade-off: a staff user who also has a merchant desk will not see these
-- unverified open rows on staff screens either; they use a staff-only account
-- or the FinOps verification screens to action them.
--
-- Nothing is deleted or flagged: once the customer passes the gate (payout
-- destination verified, exception granted, ...) the row reappears by itself.

ALTER POLICY "Owners staff and assigned merchant agents can view withdrawals"
ON public.withdrawal_requests
USING (
  (user_id = (select auth.uid()))
  OR (
    (select public.is_withdrawal_staff((select auth.uid())))
    AND NOT (
      (select public.is_active_cashout_agent((select auth.uid())))
      AND assigned_cashout_agent_id IS NULL
      AND status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved')
      AND NOT public.withdrawal_merchant_id_gate(user_id, landlord_payout_id, reason)
    )
  )
  OR (
    (select public.is_active_cashout_agent((select auth.uid())))
    AND public.withdrawal_merchant_id_gate(user_id, landlord_payout_id, reason)
    AND (
      (assigned_cashout_agent_id IS NULL)
      OR (assigned_cashout_agent_id = (
        SELECT ca.id FROM public.cashout_agents ca
        WHERE ca.agent_id = (select auth.uid())
        LIMIT 1
      ))
      OR (dispatch_claimed_by = (select auth.uid()))
      OR (processed_by = (select auth.uid()))
    )
  )
);
