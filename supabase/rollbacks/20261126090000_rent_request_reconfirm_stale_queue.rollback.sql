-- Rollback for 20261126090000_rent_request_reconfirm_stale_queue.sql (doc 275).
-- Restores service_center_vetting_items() and block_all_notification_inserts() to their live
-- bodies of 16 Nov 2026 and removes the reconfirmation job, functions and table.
-- Does NOT reopen requests already set to 'cancelled'; the table is the record of which ones
-- (outcome closed_superseded / closed_no_reply) - export it before dropping if they must be reopened.

select cron.unschedule(jobid) from cron.job where jobname = 'close-unanswered-rent-request-reconfirmations';

CREATE OR REPLACE FUNCTION public.service_center_vetting_items()
 RETURNS TABLE(manager_id uuid, kind text, item_id uuid, label text, clock_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pol AS (SELECT effective_from FROM public.service_center_vetting_policy WHERE id)
  SELECT rr.service_center_manager_id, 'rent_plan'::text, rr.id, tp.full_name,
         GREATEST(rr.created_at, pol.effective_from)
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    CROSS JOIN pol
   WHERE rr.status = 'service_center_review' AND rr.service_center_manager_id IS NOT NULL
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
    'desk_morning_brief'
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

drop function if exists public.rent_request_reconfirm_audience();
drop function if exists public.close_unanswered_rent_request_reconfirmations();
drop function if exists public.confirm_rent_request_still_needed(uuid);
drop function if exists public.start_rent_request_reconfirmation(boolean, integer);
drop table if exists public.rent_request_reconfirmations;
