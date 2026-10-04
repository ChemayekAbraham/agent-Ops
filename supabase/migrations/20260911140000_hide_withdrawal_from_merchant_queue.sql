-- FinOps-only visibility toggle: lets Financial Ops suppress a withdrawal
-- from the Merchant Agent payout queue without touching its status or
-- settlement state (e.g. while it's being handled through an alternate
-- channel). Read by src/lib/merchantPayoutQueue.ts (applyMerchantQueueFence /
-- isMerchantQueueActionable) and by the v_merchant_payout_queue view below.

alter table public.withdrawal_requests
  add column if not exists hidden_from_merchant_queue boolean not null default false,
  add column if not exists hidden_from_merchant_queue_at timestamptz,
  add column if not exists hidden_from_merchant_queue_by uuid references auth.users(id);

comment on column public.withdrawal_requests.hidden_from_merchant_queue is
  'FinOps visibility toggle: when true, this withdrawal is suppressed from the Merchant Agent payout queue without changing status/settlement state.';

-- Re-fence the queue view with the new predicate. Column list is unchanged
-- (CREATE OR REPLACE VIEW cannot drop/reorder existing output columns).
create or replace view public.v_merchant_payout_queue
with (security_invoker = true) as
select
  id,
  user_id,
  amount,
  status,
  processed_by,
  processed_at,
  rejection_reason,
  created_at,
  updated_at,
  mobile_money_number,
  mobile_money_provider,
  transaction_id,
  mobile_money_name,
  manager_approved_at,
  manager_approved_by,
  cfo_approved_at,
  cfo_approved_by,
  coo_approved_at,
  coo_approved_by,
  transaction_time,
  payout_method,
  bank_name,
  bank_account_number,
  bank_account_name,
  agent_location,
  agent_id,
  payout_proof,
  payout_proof_type,
  payout_code,
  assigned_cashout_agent_id,
  priority_level,
  auto_dispatched,
  dispatched_at,
  fin_ops_reference,
  fin_ops_verified_by,
  fin_ops_verified_at,
  fin_ops_approved_at,
  fin_ops_approved_by,
  reason,
  fin_ops_payment_method,
  linked_party,
  proxy_partner_id,
  client_request_id,
  initiated_by,
  beneficiary_id,
  processing_started_at,
  processing_started_by,
  preferred_cashout_agent_id,
  landlord_payout_id,
  receipt_token,
  dispatch_round,
  dispatch_expires_at,
  dispatch_claimed_by,
  dispatch_claimed_at,
  dispatch_escalated_at,
  payout_proof_path,
  payout_proof_bucket,
  payout_proof_uploaded_at,
  payout_proof_uploaded_by,
  pool_funded,
  payout_route_ref,
  intent_key
from public.withdrawal_requests w
where w.status = any (array['pending'::text, 'requested'::text, 'manager_approved'::text, 'cfo_approved'::text, 'fin_ops_approved'::text])
  and w.processed_at is null
  and w.fin_ops_reference is null
  and w.hidden_from_merchant_queue is not true;
