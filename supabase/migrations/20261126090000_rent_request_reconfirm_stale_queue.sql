-- doc 275: ask tenants with stale rent requests whether they still need rent, then close.
--
-- 3,776 requests sit in pending / service_center_review, untouched since Aug-Oct 2026
-- (most created 15-19 Aug and moved into review by a one-off backfill). They look like
-- real people who never heard back, so the CTO chose "ask first, then close" (16 Nov).
--
--   start_rent_request_reconfirmation(p_apply)   CTO / COO / super admin. Dry run unless p_apply.
--       closes requests the tenant has replaced (newer request) or that sit beside a running
--       Rent Plan, asks the rest (in-app notification), records each in the table below.
--   confirm_rent_request_still_needed(id)         the tenant's "Yes, I still need rent".
--   close_unanswered_rent_request_reconfirmations()  daily job: unanswered after the reply-by
--       date -> request cancelled, tenant told.
--   rent_request_reconfirm_audience()             phones for the broadcast-audience-sms audience.
-- service_center_vetting_items() stops counting requests waiting on the tenant and counts a
-- confirmed request's age from the confirmation (it is not in critical_function_baselines).
-- Rollback: supabase/rollbacks/20261126090000_rent_request_reconfirm_stale_queue.rollback.sql

create table if not exists public.rent_request_reconfirmations (
  rent_request_id uuid primary key references public.rent_requests(id) on delete cascade,
  tenant_id uuid not null,
  asked_at timestamptz not null default now(),
  respond_by timestamptz not null,
  confirmed_at timestamptz,
  closed_at timestamptz,
  outcome text not null default 'asked'
    check (outcome in ('asked', 'still_needed', 'closed_no_reply', 'closed_superseded', 'closed_has_plan')),
  started_by uuid
);
create index if not exists rent_request_reconfirmations_tenant_idx on public.rent_request_reconfirmations (tenant_id);
create index if not exists rent_request_reconfirmations_open_idx on public.rent_request_reconfirmations (respond_by) where outcome = 'asked';

alter table public.rent_request_reconfirmations enable row level security;
grant select on public.rent_request_reconfirmations to authenticated;
grant select, insert, update, delete on public.rent_request_reconfirmations to service_role;

create policy rent_request_reconfirmations_tenant_read on public.rent_request_reconfirmations
  for select to authenticated using ((select auth.uid()) = tenant_id);
create policy rent_request_reconfirmations_ops_read on public.rent_request_reconfirmations
  for select to authenticated using ((select public.is_ops_role((select auth.uid()))));
create policy mfa_required_for_staff on public.rent_request_reconfirmations
  as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

-- Stale = still waiting, sent 30+ days ago, nothing changed for 14+ days, not asked before.
create or replace function public.start_rent_request_reconfirmation(p_apply boolean default false, p_reply_days integer default 14)
returns table(closed_superseded integer, closed_has_plan integer, asked integer)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_respond_by timestamptz := now() + make_interval(days => greatest(7, least(coalesce(p_reply_days, 14), 30)));
begin
  if v_actor is null or not (public.has_role(v_actor, 'cto'::app_role) or public.has_role(v_actor, 'coo'::app_role)
                             or public.has_role(v_actor, 'super_admin'::app_role)) then
    raise exception 'Not authorised';
  end if;

  drop table if exists _stale;
  create temp table _stale on commit drop as
  select rr.id, rr.tenant_id, rr.created_at,
         case
           when exists (select 1 from public.rent_requests r2
                         where r2.tenant_id = rr.tenant_id and r2.id <> rr.id and r2.created_at > rr.created_at)
             then 'closed_superseded'
           when exists (select 1 from public.rent_requests r2
                         where r2.tenant_id = rr.tenant_id and r2.status in ('funded', 'disbursed', 'repaying'))
             then 'closed_has_plan'
           else 'asked'
         end as outcome
    from public.rent_requests rr
   where rr.status in ('pending', 'service_center_review')
     and rr.tenant_id is not null
     and rr.created_at < now() - interval '30 days'
     and greatest(rr.updated_at, coalesce((select max(e.occurred_at) from public.rent_request_stage_events e
                                           where e.rent_request_id = rr.id), rr.created_at)) < now() - interval '14 days'
     and not exists (select 1 from public.rent_request_reconfirmations c where c.rent_request_id = rr.id);

  if coalesce(p_apply, false) then
    insert into public.rent_request_reconfirmations (rent_request_id, tenant_id, respond_by, closed_at, outcome, started_by)
    select s.id, s.tenant_id, v_respond_by, case when s.outcome = 'asked' then null else now() end, s.outcome, v_actor
      from _stale s;

    update public.rent_requests rr set status = 'cancelled'
      from _stale s where s.id = rr.id and s.outcome <> 'asked';

    insert into public.notifications (user_id, title, message, type, link_path, event_key, metadata)
    select s.tenant_id,
           'Do you still need rent?',
           'You asked Welile for rent support on ' || to_char(s.created_at at time zone 'Africa/Kampala', 'DD Mon YYYY')
             || '. If you still need it, open Your Rent Plan and tap "Yes, I still need rent" by '
             || to_char(v_respond_by at time zone 'Africa/Kampala', 'DD Mon YYYY')
             || '. If we do not hear from you we will close this request, and you can apply again any time.',
           'rent_request_reconfirm',
           '/dashboard/tenant?tab=rent-plan',
           'rent_request_reconfirm:' || s.id,
           jsonb_build_object('rent_request_id', s.id, 'respond_by', v_respond_by)
      from _stale s where s.outcome = 'asked';
  end if;

  return query
  select count(*) filter (where s.outcome = 'closed_superseded')::int,
         count(*) filter (where s.outcome = 'closed_has_plan')::int,
         count(*) filter (where s.outcome = 'asked')::int
    from _stale s;
end $function$;
grant execute on function public.start_rent_request_reconfirmation(boolean, integer) to authenticated;

create or replace function public.confirm_rent_request_still_needed(p_rent_request_id uuid)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Sign in to continue'; end if;
  update public.rent_request_reconfirmations c
     set confirmed_at = now(), outcome = 'still_needed'
   where c.rent_request_id = p_rent_request_id and c.tenant_id = v_uid and c.outcome = 'asked'
     and exists (select 1 from public.rent_requests rr
                  where rr.id = c.rent_request_id and rr.status in ('pending', 'service_center_review'));
  return found;
end $function$;
grant execute on function public.confirm_rent_request_still_needed(uuid) to authenticated;

-- Daily job only (service role / owner): no grant to authenticated.
create or replace function public.close_unanswered_rent_request_reconfirmations()
returns integer
language plpgsql security definer set search_path to 'public'
as $function$
declare v_n integer;
begin
  drop table if exists _due;
  create temp table _due on commit drop as
  select c.rent_request_id, c.tenant_id from public.rent_request_reconfirmations c
   where c.outcome = 'asked' and c.respond_by < now();

  update public.rent_requests rr set status = 'cancelled'
    from _due d where d.rent_request_id = rr.id and rr.status in ('pending', 'service_center_review');

  update public.rent_request_reconfirmations c set outcome = 'closed_no_reply', closed_at = now()
    from _due d where d.rent_request_id = c.rent_request_id;
  get diagnostics v_n = row_count;

  insert into public.notifications (user_id, title, message, type, link_path, event_key, metadata)
  select d.tenant_id, 'Rent request closed',
         'We did not hear back, so we closed your old rent request. You can send a new request any time.',
         'rent_request_reconfirm_closed', '/dashboard/tenant',
         'rent_request_reconfirm_closed:' || d.rent_request_id, jsonb_build_object('rent_request_id', d.rent_request_id)
    from _due d;
  return v_n;
end $function$;

-- Phones for the "still need rent?" SMS (broadcast-audience-sms, service role).
create or replace function public.rent_request_reconfirm_audience()
returns table(tenant_id uuid)
language sql stable security definer set search_path to 'public'
as $function$
  select distinct c.tenant_id from public.rent_request_reconfirmations c
   where c.outcome = 'asked' and c.respond_by > now();
$function$;

-- Requests waiting on the tenant are not overdue for the service centre; a confirmed
-- request's clock starts at the confirmation. Landlord and LC1 branches unchanged.
create or replace function public.service_center_vetting_items()
returns table(manager_id uuid, kind text, item_id uuid, label text, clock_at timestamp with time zone)
language sql stable security definer set search_path to 'public'
as $function$
  WITH pol AS (SELECT effective_from FROM public.service_center_vetting_policy WHERE id)
  SELECT rr.service_center_manager_id, 'rent_plan'::text, rr.id, tp.full_name,
         GREATEST(rr.created_at, pol.effective_from, rc.confirmed_at)
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.rent_request_reconfirmations rc ON rc.rent_request_id = rr.id
    CROSS JOIN pol
   WHERE rr.status = 'service_center_review' AND rr.service_center_manager_id IS NOT NULL
     AND (rc.rent_request_id IS NULL OR rc.outcome = 'still_needed')
  UNION ALL
  SELECT l.service_center_manager_id, 'landlord', l.id, l.name, GREATEST(l.created_at, pol.effective_from)
    FROM public.landlords l CROSS JOIN pol
   WHERE l.service_center_status = 'pending' AND l.service_center_manager_id IS NOT NULL
     AND COALESCE(l.verified, false) = false AND COALESCE(l.verification_status, 'pending') <> 'verified'
  UNION ALL
  SELECT c.service_center_manager_id, 'lc1', c.id, c.name, GREATEST(COALESCE(c.registered_at, c.created_at), pol.effective_from)
    FROM public.lc1_chairpersons c CROSS JOIN pol
   WHERE c.service_center_status = 'pending' AND c.service_center_manager_id IS NOT NULL
     AND COALESCE(c.verified, false) = false AND COALESCE(c.verification_status, 'pending') <> 'verified';
$function$;

-- In-app notifications are dropped unless their type is on this allowlist. Rebuilt from the
-- live body (16 Nov 2026) with only 'rent_request_reconfirm' and 'rent_request_reconfirm_closed' added.
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN (
    'merchandise_recovery','director_requisition','advance_arrears','budget',
    'staff_requisition','hr_birthday','rd_alert','lending_repayment',
    'float','bike_lease_reminder','wallet_transfer_reversal',
    'security','staff_assistant','staff_assistant_reminder','desk_send_back',
    'desk_morning_brief','rent_request_reconfirm','rent_request_reconfirm_closed'
  ) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN ('listing_rejected','subagent_listing_rejected') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'kind','') = 'landlord_payout_rejected' THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

-- 07:00 Kampala daily.
select cron.unschedule(jobid) from cron.job where jobname = 'close-unanswered-rent-request-reconfirmations';
select cron.schedule('close-unanswered-rent-request-reconfirmations', '0 4 * * *',
                     $$select public.close_unanswered_rent_request_reconfirmations();$$);
