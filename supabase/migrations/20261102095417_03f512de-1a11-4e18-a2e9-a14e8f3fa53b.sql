CREATE OR REPLACE FUNCTION public.delete_welile_home_subscription(p_subscription_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sub public.welile_homes_subscriptions%rowtype;
  v_has_rejected boolean;
begin
  select * into v_sub from public.welile_homes_subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'Subscription not found'; end if;

  if not coalesce(v_sub.agent_id = auth.uid(), false)
     and not coalesce(v_sub.enrolled_by = auth.uid(), false)
     and not public.has_role(auth.uid(), 'manager') then
    raise exception 'Permission denied';
  end if;

  if exists (select 1 from public.welile_homes_monthly_dues d
              where d.subscription_id = p_subscription_id
                and (coalesce(d.amount_collected, 0) > 0 or d.collection_status <> 'pending'
                     or coalesce(d.payout_status, 'unpaid') <> 'unpaid' or d.ledger_transaction_id is not null)) then
    raise exception 'PLAN_NOT_DELETABLE: rent collections or landlord payouts are recorded on this plan' using errcode = '42501';
  end if;

  if coalesce(v_sub.receivable_total, 0) > 0 and coalesce(v_sub.outstanding_balance, 0) < v_sub.receivable_total then
    raise exception 'PLAN_NOT_DELETABLE: this plan''s balance has already been reduced' using errcode = '42501';
  end if;

  if v_sub.funding_status = 'funded' then
    raise exception 'PLAN_NOT_DELETABLE: float is funded for this plan' using errcode = '42501';
  end if;

  -- Any attached request that is not rejected/cancelled blocks deletion.
  if exists (select 1 from public.welile_homes_float_request_items i
               join public.float_requests fr on fr.id = i.float_request_id
              where i.subscription_id = p_subscription_id
                and fr.status not in ('rejected','cancelled')) then
    raise exception 'PLAN_NOT_DELETABLE: this plan is attached to an active or approved float request' using errcode = '42501';
  end if;

  -- 'requested' is allowed only when every attached request was rejected/cancelled.
  if v_sub.funding_status = 'requested' then
    select exists (select 1 from public.welile_homes_float_request_items i
                    join public.float_requests fr on fr.id = i.float_request_id
                   where i.subscription_id = p_subscription_id and fr.status in ('rejected','cancelled'))
      into v_has_rejected;
    if not v_has_rejected then
      raise exception 'PLAN_NOT_DELETABLE: float is requested for this plan' using errcode = '42501';
    end if;
  end if;

  delete from public.welile_homes_monthly_dues where subscription_id = p_subscription_id;
  delete from public.welile_homes_enrollment_audit where subscription_id = p_subscription_id;
  delete from public.welile_homes_float_request_items i
   using public.float_requests fr
   where fr.id = i.float_request_id and i.subscription_id = p_subscription_id and fr.status in ('rejected','cancelled');
  delete from public.welile_homes_subscriptions where id = p_subscription_id;
  return true;
end;
$function$;