-- The "+ in-app" half of section 5's agent messages has never worked.
--
-- Section 5 of docs/rent-plan-new-flow-full-report.md specifies three agent
-- messages that include an in-app notification:
--
--   A1  CFO disburses landlord float   SMS + email + IN-APP
--   A4  24 hours, float returned       SMS + IN-APP
--   A5  payout fails after dispatch    IN-APP + FinOps alert
--
-- The SMS legs are live. The in-app legs are not, and A1's has been failing
-- silently since the day it was written.
--
-- WHY. On 2026-03-30 a migration titled "Notifications Insert Blocker" added
-- `block_all_notification_inserts` — a BEFORE INSERT trigger on
-- `notifications` that does nothing but `RETURN NULL`, discarding every row
-- without raising. It was a deliberate CPU measure and it disabled several
-- notification triggers on other tables in the same breath. Since then, types
-- have been allowlisted back one at a time as features needed them
-- (`lending_repayment` on 2026-09-24 being the most recent).
--
-- `fund-agent-landlord-float` inserts its notification with `type = 'float'`,
-- which is not on that list. Measured: 0 of 24,606 notifications have ever had
-- that type, while 21,916 of them are a single allowlisted type. The insert
-- runs, returns no error, and the row is dropped.
--
-- So adding `float` is the established pattern for this table, not a
-- workaround — and it is the smallest change that makes A1 deliver what the
-- spec says it delivers.
--
-- A4 AND A5 HAD NO IN-APP WRITE AT ALL. `detect_idle_landlord_float` records
-- both outcomes in `system_events`, which is an audit trail, not something an
-- agent ever sees. They now also write a notification, on the same two
-- branches that already exist:
--
--   auto_recalled               -> A4, the float was taken back
--   escalated_payout_attempted  -> A5, retry required, explicitly NO penalty
--
-- A5's wording says "no penalty" because the spec says so, and because the
-- agent did nothing wrong: their payout was dispatched and the merchant leg
-- failed. Leaving them to guess is how a good agent learns to distrust the app.

-- 1. Let the float notifications through --------------------------------
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN (
    'merchandise_recovery',
    'director_requisition',
    'advance_arrears',
    'budget',
    'staff_requisition',
    'hr_birthday',
    'rd_alert',
    'lending_repayment',
    -- Landlord float: A1 (float arrived), A4 (float returned) and A5 (payout
    -- failed, retry, no penalty) from section 5 of the Rent Plan flow report.
    'float'
  ) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN (
    'listing_rejected',
    'subagent_listing_rejected'
  ) THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

-- 2. A4 and A5 get the in-app notice the spec asks for -------------------
--
-- Patched onto the existing outcome branches rather than restated, because the
-- detector is a long function and the two branches are already exactly where
-- the spec's two events are decided.
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'detect_idle_landlord_float';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'detect_idle_landlord_float not found';
  END IF;

  IF v_src LIKE '%landlord_float_a5_inapp%' THEN
    RAISE NOTICE 'Already applied - the in-app notices are already in place.';
    RETURN;
  END IF;

  -- A5: a payout was dispatched or failed, so this is escalated, never recalled.
  v_new := replace(v_src,
$anchor$        INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
        VALUES ('landlord_float_idle_escalated', r.agent_id, 'rent_request', r.rent_request_id,$anchor$,
$repl$        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        VALUES (r.agent_id,
                'Landlord payout needs another attempt',
                format('The payout for %s has not gone through. Please retry it. There is no penalty - the float stays with you and your tenant is unaffected.',
                       COALESCE(r.landlord_name, 'the landlord')),
                'float',
                jsonb_build_object('notice','landlord_float_a5_inapp',
                                   'rent_request_id', r.rent_request_id,
                                   'allocation_id', r.allocation_id,
                                   'amount', r.amount));

        INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
        VALUES ('landlord_float_idle_escalated', r.agent_id, 'rent_request', r.rent_request_id,$repl$);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'A5 anchor not found in detect_idle_landlord_float';
  END IF;
  v_src := v_new;

  -- A4: nothing was ever dispatched, the float has been taken back.
  v_new := replace(v_src,
$anchor$          UPDATE public.landlord_float_idle_alerts
             SET outcome = 'auto_recalled', resolved_at = n$anchor$,
$repl$          INSERT INTO public.notifications (user_id, title, message, type, metadata)
          VALUES (r.agent_id,
                  'Landlord float returned',
                  format('The %s landlord float for %s was not paid out within 24 hours and has been returned. %s''s Rent Plan has been cancelled and can be submitted again.',
                         to_char(r.amount, 'FM999,999,999'),
                         COALESCE(r.landlord_name, 'the landlord'),
                         COALESCE(r.tenant_name, 'The tenant')),
                  'float',
                  jsonb_build_object('notice','landlord_float_a4_inapp',
                                     'rent_request_id', r.rent_request_id,
                                     'allocation_id', r.allocation_id,
                                     'amount', r.amount));

          UPDATE public.landlord_float_idle_alerts
             SET outcome = 'auto_recalled', resolved_at = n$repl$);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'A4 anchor not found in detect_idle_landlord_float';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.detect_idle_landlord_float(p_system_actor uuid DEFAULT NULL::uuid)
     RETURNS jsonb
     LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;
