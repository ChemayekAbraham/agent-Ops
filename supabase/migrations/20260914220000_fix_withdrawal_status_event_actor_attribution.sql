-- Findings 2 & 3 from an independent E2E test agent's payments report
-- (2026-09-14): a direct database status update can move a withdrawal
-- straight to 'completed' without traversing manager/CFO/FinOps
-- approval, and when it does, log_withdrawal_status_event() attributed
-- the resulting system_events row to COALESCE(NEW.processed_by,
-- NEW.user_id) -- falling all the way back to the WITHDRAWAL OWNER when
-- processed_by was null, which can make a staff bypass look like the
-- recipient approved their own payout.
--
-- Investigated Finding 2 first, since "can be bypassed" needed scoping:
-- approve-withdrawal's own approvableStatuses is
-- ["pending", "requested", "manager_approved"] -- manager approval is
-- already OPTIONAL by design, not a required stage FinOps must wait for.
-- Confirmed against live data: of 8,705 approved/completed withdrawals,
-- the overwhelming majority go directly from pending to a single FinOps
-- completion with no manager/cfo stage at all -- that is normal,
-- intended behavior, not a workflow violation. Building a DB-level state
-- machine that requires all three stages would break real, legitimate
-- traffic. No such enforcement was added.
--
-- Finding 3 (actor misattribution) is real and narrow, independent of
-- that workflow question. Checked how often it actually bites:
-- processed_by IS NULL on 78 of 8,705 approved/completed rows (~0.9%),
-- and the reasons on those 78 are almost entirely "Proxy payout delivery
-- for ..." -- automated/scheduled proxy-partner payouts with
-- legitimately no human processed_by, not evidence of a staff bypass.
-- Still, the old fallback was wrong in BOTH directions: it could
-- misattribute a system/cron completion to its recipient, and it would
-- equally misattribute a staff member's direct bypass of
-- approve-withdrawal to the wrong person (the owner, not the actor).
--
-- Fix: prefer auth.uid() (the actual authenticated caller of the
-- current statement, if any) over NEW.user_id as the fallback when
-- processed_by is null. If neither exists (a genuine service-role/cron
-- write with no user session), the actor is left NULL and
-- metadata.actor_type is explicitly set to 'system' -- never silently
-- guessed as the owner. This is the same "actor_type = system" pattern
-- the user asked for elsewhere in this initiative for exactly this
-- situation.
--
-- Verified with two rolled-back tests: (1) a direct UPDATE with
-- request.jwt.claim.sub set to a real user and no processed_by -- the
-- resulting system_events row correctly attributed user_id to that
-- actual caller, not the withdrawal's owner. (2) the same UPDATE with no
-- auth context at all -- user_id came back NULL with
-- metadata.actor_type = 'system', not silently defaulted to the owner.

CREATE OR REPLACE FUNCTION public.log_withdrawal_status_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_type text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'approved' OR NEW.status = 'completed' THEN
      v_actor := COALESCE(NEW.processed_by, auth.uid());
      v_actor_type := CASE WHEN v_actor IS NOT NULL THEN 'user' ELSE 'system' END;
      PERFORM public.log_system_event(
        'withdrawal_approved'::system_event_type,
        v_actor,
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id, 'stage', NEW.status, 'actor_type', v_actor_type)
      );
    ELSIF NEW.status IN ('manager_approved', 'cfo_approved', 'fin_ops_approved') THEN
      v_actor := COALESCE(
        CASE NEW.status
          WHEN 'manager_approved' THEN NEW.manager_approved_by
          WHEN 'cfo_approved' THEN NEW.cfo_approved_by
          WHEN 'fin_ops_approved' THEN NEW.fin_ops_approved_by
          ELSE NULL
        END,
        NEW.processed_by, auth.uid()
      );
      v_actor_type := CASE WHEN v_actor IS NOT NULL THEN 'user' ELSE 'system' END;
      PERFORM public.log_system_event(
        'withdrawal_approved'::system_event_type,
        v_actor,
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id, 'stage', NEW.status, 'actor_type', v_actor_type)
      );
    ELSIF NEW.status = 'rejected' THEN
      v_actor := COALESCE(NEW.processed_by, auth.uid());
      v_actor_type := CASE WHEN v_actor IS NOT NULL THEN 'user' ELSE 'system' END;
      PERFORM public.log_system_event(
        'withdrawal_rejected'::system_event_type,
        v_actor,
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id, 'reason', NEW.rejection_reason, 'actor_type', v_actor_type)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
