-- Cash-out agents may keep browsing the unclaimed payout queue, but the payout
-- account numbers/names are hidden until they claim the request.

CREATE OR REPLACE VIEW public.cashout_queue_view AS
SELECT
  w.id, w.user_id, w.amount, w.status, w.processed_by, w.processed_at, w.rejection_reason,
  w.created_at, w.updated_at,
  CASE WHEN w.mobile_money_number IS NULL THEN NULL
       ELSE '••••' || right(w.mobile_money_number, 3) END AS mobile_money_number,
  w.mobile_money_provider, w.transaction_id,
  CASE WHEN w.mobile_money_name IS NULL THEN NULL ELSE 'Hidden until claimed' END AS mobile_money_name,
  w.manager_approved_at, w.manager_approved_by, w.cfo_approved_at, w.cfo_approved_by,
  w.coo_approved_at, w.coo_approved_by, w.transaction_time, w.payout_method, w.bank_name,
  CASE WHEN w.bank_account_number IS NULL THEN NULL
       ELSE '••••' || right(w.bank_account_number, 3) END AS bank_account_number,
  CASE WHEN w.bank_account_name IS NULL THEN NULL ELSE 'Hidden until claimed' END AS bank_account_name,
  w.agent_location, w.agent_id, w.payout_proof, w.payout_proof_type, w.payout_code,
  w.assigned_cashout_agent_id, w.priority_level, w.auto_dispatched, w.dispatched_at,
  w.fin_ops_reference, w.fin_ops_verified_by, w.fin_ops_verified_at, w.fin_ops_approved_at,
  w.fin_ops_approved_by, w.reason, w.fin_ops_payment_method, w.linked_party, w.proxy_partner_id,
  w.client_request_id, w.initiated_by, w.beneficiary_id, w.processing_started_at,
  w.processing_started_by, w.preferred_cashout_agent_id, w.landlord_payout_id, w.receipt_token,
  w.dispatch_round, w.dispatch_expires_at, w.dispatch_claimed_by, w.dispatch_claimed_at,
  w.dispatch_escalated_at, w.payout_proof_path, w.payout_proof_bucket, w.payout_proof_uploaded_at,
  w.payout_proof_uploaded_by, w.pool_funded, w.payout_route_ref, w.intent_key, w.settlement_state,
  w.settlement_missing_legs, w.settlement_checked_at, w.settlement_attempts,
  w.payout_proof_verification_status, w.payout_proof_verified_at,
  w.hidden_from_merchant_queue, w.hidden_from_merchant_queue_at, w.hidden_from_merchant_queue_by
FROM public.withdrawal_requests w
WHERE w.status IN ('pending','requested','approved','manager_approved','cfo_approved','fin_ops_approved')
  AND (
    public.is_active_cashout_agent(auth.uid())
    OR public.is_withdrawal_staff(auth.uid())
  );

GRANT SELECT ON public.cashout_queue_view TO authenticated;

-- Full rows on the base table now require ownership, staff, or an actual claim.
DROP POLICY IF EXISTS "Owners staff and active merchant agents can view withdrawals" ON public.withdrawal_requests;

CREATE POLICY "Owners staff and assigned merchant agents can view withdrawals"
ON public.withdrawal_requests
FOR SELECT
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT public.is_withdrawal_staff((SELECT auth.uid())))
  OR (
    (SELECT public.is_active_cashout_agent((SELECT auth.uid())))
    AND (
      assigned_cashout_agent_id = (
        SELECT ca.id FROM public.cashout_agents ca WHERE ca.agent_id = (SELECT auth.uid()) LIMIT 1
      )
      OR dispatch_claimed_by = (SELECT auth.uid())
      OR processed_by = (SELECT auth.uid())
    )
  )
);