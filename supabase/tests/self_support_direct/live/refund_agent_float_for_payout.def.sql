CREATE OR REPLACE FUNCTION public.refund_agent_float_for_payout(p_payout_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
