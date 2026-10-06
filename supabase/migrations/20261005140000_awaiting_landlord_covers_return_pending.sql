-- The "landlord not paid" gate must also hold while a float return is pending.
--
-- `rent_plan_awaiting_landlord` is the single predicate behind three things:
-- the disabled Collect button and "Landlord not paid" label in
-- TenantProfileView, and the hard AWAITING_LANDLORD_PAYMENT block in the
-- tenant-pay-rent edge function. It answered true only for allocations in
-- `open` or `partially_paid`.
--
-- An allocation sitting at `return_pending` fell through that list, so a plan
-- whose landlord demonstrably has NOT been paid — the float is parked awaiting
-- a CFO decision — looked collectable: the button went live and a tenant
-- repayment would have been accepted.
--
-- `return_pending` belongs in the gate whichever way the CFO decides:
--   * reject  -> allocation returns to `open`, landlord still unpaid, gate
--                should have been closed the whole time
--   * approve -> the plan is unwound and the rent request goes back to
--                `agent_ops_approved`, so a repayment taken meanwhile was for
--                rent the landlord never received, on a plan about to be
--                cancelled
--
-- The `paid_out_amount = 0` test and the pre-go-live exemption are unchanged,
-- so the pre-recall backlog keeps collecting. Of the three allocations in
-- `return_pending` as at 2026-10-05, only one was created after go-live
-- (Doreen Walulya, UGX 300,000) and so only that plan's gate changes.
--
-- Signature, LANGUAGE sql, volatility and search_path unchanged.

create or replace function public.rent_plan_awaiting_landlord(p_rent_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  SELECT EXISTS (
    SELECT 1
      FROM public.agent_landlord_float_allocations al
     WHERE al.rent_request_id = p_rent_request_id
       AND al.status IN ('open', 'partially_paid', 'return_pending')
       AND COALESCE(al.paid_out_amount, 0) = 0
       AND al.created_at >= public.landlord_float_recall_go_live()
  );
$$;

comment on function public.rent_plan_awaiting_landlord(uuid) is
  'True while a Rent Plan''s landlord float is still with the agent and nothing has been paid out — including allocations parked at return_pending awaiting a CFO decision. Gates the agent Collect button and the tenant-pay-rent repayment path.';
