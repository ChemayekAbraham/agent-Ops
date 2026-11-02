create or replace function public.delete_welile_home_subscription(p_subscription_id uuid)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_sub public.welile_homes_subscriptions%rowtype;
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

  if v_sub.funding_status in ('requested', 'funded') then
    raise exception 'PLAN_NOT_DELETABLE: float is % for this plan', v_sub.funding_status using errcode = '42501';
  end if;

  if exists (select 1 from public.welile_homes_float_request_items i
               join public.float_requests fr on fr.id = i.float_request_id
              where i.subscription_id = p_subscription_id
                and (i.released_at is null or fr.status in ('approved','funded','disbursed'))) then
    raise exception 'PLAN_NOT_DELETABLE: this plan is attached to an active or approved float request' using errcode = '42501';
  end if;

  delete from public.welile_homes_monthly_dues where subscription_id = p_subscription_id;
  delete from public.welile_homes_enrollment_audit where subscription_id = p_subscription_id;
  delete from public.welile_homes_subscriptions where id = p_subscription_id;
  return true;
end;
$$;

create or replace function public._wh_dues_delete_guard()
returns trigger language plpgsql set search_path = public
as $$
begin
  if coalesce(old.amount_collected, 0) > 0 or old.collection_status <> 'pending'
     or coalesce(old.payout_status, 'unpaid') <> 'unpaid' or old.ledger_transaction_id is not null then
    raise exception 'DUE_NOT_DELETABLE: payments are recorded on this monthly due' using errcode = '42501';
  end if;
  return old;
end;
$$;
revoke all on function public._wh_dues_delete_guard() from public, anon, authenticated;

drop trigger if exists trg_wh_dues_delete_guard on public.welile_homes_monthly_dues;
create trigger trg_wh_dues_delete_guard before delete on public.welile_homes_monthly_dues
  for each row execute function public._wh_dues_delete_guard();