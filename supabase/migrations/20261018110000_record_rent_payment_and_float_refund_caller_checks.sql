-- 2026-10-18 (doc 247, step 6): two owner-rights functions the browser calls had no check on the caller and were executable by anon.
--
-- record_rent_payment(p_landlord_id, p_amount): reduces landlords.rent_balance_due and stamps rent_last_paid_*. The table's guard trigger
--   (guard_landlord_sensitive_columns) reverts those columns for signed-in callers who are not agents/staff, but it returns early when
--   auth.uid() IS NULL, so a SIGNED-OUT caller could clear any landlord's balance. Now: service role; staff who can edit sensitive landlord fields
--   (is_sensitive_field_editor); an agent / senior agent linked to the landlord (registered_by, managed_by_agent_id, active assignment); or the
--   landlord's tenant. Signed-out access revoked. p_amount must be > 0.
--   NOTE: the money itself moves earlier, in the wallet-transfer edge function; this call only updates landlord bookkeeping from the browser
--   (PayLandlordDialog). Moving it into wallet-transfer is the proper follow-up. For plain tenants the trigger still reverts the columns.
--
-- refund_agent_float_for_payout(p_payout_id, p_reason): adds the payout amount back to the agent's landlord float, reopens the allocation and marks
--   the payout failed. The float is deducted by trigger deduct_float_on_withdrawal when the payout is created, so a refund is only correct BEFORE the
--   landlord is paid. It refused only status 'completed', so any caller could refund the payouts in 'awaiting_agent_receipt' (the landlord has
--   already been paid: finops disburse sets that status) and get the float back. Now: service role (the SLA monitor) or finance staff only
--   (manager/super_admin/ceo/coo/cfo/financial_ops/admin, or an active staff permission for financial-ops/company-ops); and only while the payout is
--   unpaid: otp_verified, pending_finops_disbursement, pending_merchant_payout, disbursing. awaiting_agent_receipt and completed are refused.
--   failed/refunded/escalated stay a no-op. Signed-out access revoked.
create or replace function public.record_rent_payment(p_landlord_id uuid, p_amount numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_l public.landlords%rowtype;
  v_ok boolean := false;
begin
  if p_amount is null or p_amount <= 0 then return; end if;
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    select * into v_l from public.landlords where id = p_landlord_id;
    if not found then return; end if;
    if public.is_sensitive_field_editor(v_uid) then
      v_ok := true;
    elsif v_l.tenant_id = v_uid then
      v_ok := true;
    elsif (public.has_role(v_uid, 'agent'::app_role) or public.has_role(v_uid, 'senior_agent'::app_role))
          and (v_l.registered_by = v_uid
               or v_l.managed_by_agent_id = v_uid
               or exists (select 1 from public.agent_landlord_assignments a
                           where a.landlord_id = p_landlord_id and a.agent_id = v_uid and a.status = 'active')) then
      v_ok := true;
    end if;
    if not v_ok then
      raise exception 'not allowed to record a payment for this landlord' using errcode = '42501';
    end if;
  end if;
  update public.landlords
     set rent_balance_due = greatest(0, rent_balance_due - p_amount),
         rent_last_paid_at = now(),
         rent_last_paid_amount = p_amount,
         updated_at = now()
   where id = p_landlord_id;
end;
$f$;

create or replace function public.refund_agent_float_for_payout(p_payout_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_payout public.landlord_payouts%rowtype;
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if not (
         exists (select 1 from public.user_roles ur where ur.user_id = v_uid
                  and ur.role::text = any (array['manager','super_admin','ceo','coo','cfo','financial_ops','admin']))
      or exists (select 1 from public.staff_permissions sp where sp.user_id = v_uid and sp.revoked_at is null
                  and sp.permitted_dashboard = any (array['financial-ops','company-ops']))
    ) then
      raise exception 'only finance staff can refund a landlord payout' using errcode = '42501';
    end if;
  end if;

  if p_reason is null or length(p_reason) < 10 then
    raise exception 'Refund reason must be at least 10 characters';
  end if;

  select * into v_payout from public.landlord_payouts where id = p_payout_id for update;
  if not found then raise exception 'Payout % not found', p_payout_id; end if;

  if v_payout.status in ('failed', 'refunded', 'escalated') then
    return jsonb_build_object('ok', true, 'noop', true, 'status', v_payout.status);
  end if;

  -- The float was deducted when the payout was created; it may only come back while the landlord has NOT been paid.
  if v_payout.status not in ('otp_verified', 'pending_finops_disbursement', 'pending_merchant_payout', 'disbursing') then
    raise exception 'Cannot refund a payout in status % (the landlord has already been paid)', v_payout.status using errcode = 'P0001';
  end if;

  perform 1 from public.agent_landlord_float where agent_id = v_payout.agent_id for update;

  update public.agent_landlord_float
     set balance = coalesce(balance, 0) + v_payout.amount,
         total_paid_out = greatest(coalesce(total_paid_out, 0) - v_payout.amount, 0),
         updated_at = now()
   where agent_id = v_payout.agent_id;

  if v_payout.allocation_applied_id is not null then
    update public.agent_landlord_float_allocations
       set paid_out_amount = greatest(coalesce(paid_out_amount, 0) - v_payout.amount, 0),
           -- remaining_amount is GENERATED ALWAYS (greatest(allocated_amount - paid_out_amount, 0)) and recomputes by itself.
           -- The old body assigned it, which raised "column remaining_amount can only be updated to DEFAULT" for every payout
           -- that had an allocation (nearly all), so Financial Ops "Reject and refund" always failed for them.
           status = case
             when greatest(coalesce(paid_out_amount, 0) - v_payout.amount, 0) <= 0 then 'open'
             else 'partially_paid'
           end,
           updated_at = now()
     where id = v_payout.allocation_applied_id;
  end if;

  update public.landlord_payouts
     set status = 'failed',
         last_error = p_reason,
         escalated_at = now(),
         escalated_reason = p_reason,
         updated_at = now()
   where id = p_payout_id;

  return jsonb_build_object('ok', true, 'refunded', v_payout.amount, 'reason', p_reason, 'status', 'failed',
                            'allocation_reopened', v_payout.allocation_applied_id is not null);
end;
$f$;

revoke execute on function public.record_rent_payment(uuid, numeric) from public, anon;
revoke execute on function public.refund_agent_float_for_payout(uuid, text) from public, anon;
grant execute on function public.record_rent_payment(uuid, numeric) to authenticated, service_role;
grant execute on function public.refund_agent_float_for_payout(uuid, text) to authenticated, service_role;
