-- Welile Homes: a repaying, funded or requested plan cannot be deleted.
-- PROPOSAL — not applied. Apply through the approved migration workflow only.
-- Rollback: docs/pending-migrations/welile_homes_delete_guard.rollback.sql
--
-- Why:
--   delete_welile_home_subscription (20260817204253) checked only WHO calls it (the agent,
--   the enroller or a manager) and then deleted the subscription together with its
--   welile_homes_monthly_dues (the collection record) and welile_homes_enrollment_audit rows.
--   The browser now hides Delete on locked plans, but a browser check is not a control:
--   anyone allowed to call the function could still erase a repaying plan's history.
-- What:
--   Same signature, same permission check, same deletes. Before deleting, the row is locked
--   and the function refuses (SQLSTATE 42501, message starting "PLAN_NOT_DELETABLE") when:
--     1. any monthly due has money collected, is marked collected, or has a landlord payout;
--     2. outstanding_balance < receivable_total (balance already reduced);
--     3. funding_status is 'requested' or 'funded' (column from welile_homes_float_link.sql;
--        read through to_jsonb so this works before or after that migration);
--     4. any welile_homes_float_request_items row references it (same migration; checked only
--        when the table exists — its FK is ON DELETE RESTRICT anyway, this gives a clear message).
--   Plans with none of the above (e.g. a declined application that never moved money) stay
--   deletable exactly as today.
-- Moves no money, writes no ledger, changes no grants.
--
-- Pre-apply check (read-only): plans that would become non-deletable
--   select s.id, s.subscription_status, s.receivable_total, s.outstanding_balance,
--          exists (select 1 from public.welile_homes_monthly_dues d
--                   where d.subscription_id = s.id
--                     and (coalesce(d.amount_collected,0) > 0 or d.collection_status = 'collected'
--                          or coalesce(d.payout_status,'unpaid') <> 'unpaid')) as has_collections
--     from public.welile_homes_subscriptions s;

begin;

create or replace function public.delete_welile_home_subscription(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription public.welile_homes_subscriptions%rowtype;
  v_funding text;
  v_linked boolean := false;
begin
  select * into v_subscription
    from public.welile_homes_subscriptions
   where id = p_subscription_id
   for update;

  if not found then
    raise exception 'Subscription not found';
  end if;

  if not coalesce(v_subscription.agent_id = auth.uid(), false)
     and not coalesce(v_subscription.enrolled_by = auth.uid(), false)
     and not public.has_role(auth.uid(), 'manager') then
    raise exception 'Permission denied';
  end if;

  -- 1. Collections or landlord payouts recorded
  if exists (
    select 1 from public.welile_homes_monthly_dues d
     where d.subscription_id = p_subscription_id
       and (coalesce(d.amount_collected, 0) > 0
            or d.collection_status = 'collected'
            or coalesce(d.payout_status, 'unpaid') <> 'unpaid')
  ) then
    raise exception 'PLAN_NOT_DELETABLE: rent collections or landlord payouts are recorded on this plan'
      using errcode = '42501';
  end if;

  -- 2. Balance already reduced
  if coalesce(v_subscription.receivable_total, 0) > 0
     and coalesce(v_subscription.outstanding_balance, 0) < v_subscription.receivable_total then
    raise exception 'PLAN_NOT_DELETABLE: this plan''s balance has already been reduced'
      using errcode = '42501';
  end if;

  -- 3. Float requested or funded (column may not exist yet)
  v_funding := to_jsonb(v_subscription) ->> 'funding_status';
  if v_funding in ('requested', 'funded') then
    raise exception 'PLAN_NOT_DELETABLE: float is % for this plan', v_funding
      using errcode = '42501';
  end if;

  -- 4. Linked to a float request (table may not exist yet)
  if to_regclass('public.welile_homes_float_request_items') is not null then
    execute 'select exists (select 1 from public.welile_homes_float_request_items where subscription_id = $1)'
      into v_linked using p_subscription_id;
    if v_linked then
      raise exception 'PLAN_NOT_DELETABLE: this plan is linked to a float request'
        using errcode = '42501';
    end if;
  end if;

  delete from public.welile_homes_monthly_dues where subscription_id = p_subscription_id;
  delete from public.welile_homes_enrollment_audit where subscription_id = p_subscription_id;
  delete from public.welile_homes_subscriptions where id = p_subscription_id;

  return true;
end;
$$;

commit;

-- Post-apply check: calling the function on a plan from the pre-apply list with
-- has_collections = true must raise PLAN_NOT_DELETABLE and leave the row in place.
