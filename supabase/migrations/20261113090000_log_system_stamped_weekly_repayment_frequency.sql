-- Record when the SYSTEM turns a Rent Plan into a weekly plan.
--
-- Problem (CTO, 2026-11-13, NAGASHA/SHAKIRAH review): a Rent Plan showed repayment_frequency = 'weekly' and nobody could say who set it.
-- BEFORE INSERT trigger tr_stamp_rent_request_repayment_frequency forces 'weekly' whenever the duration is a multiple of 7
-- (other than 30/60/90/120) and the plan is not an outstanding-balance plan, even if the agent submitted 'daily'.
-- ops_capture then logs the row AFTER the trigger ran, so the submitted value was lost and the plan looked like the agent's own choice.
--
-- Change: the function now writes one audit_logs row each time it overrides a submitted 'daily' to 'weekly':
--   old_values = the value as submitted, new_values = 'weekly', reason = the rule that fired,
--   user_id = the signed-in user (or, for a tenant who applied for themselves through the service role, the tenant),
--   metadata = actor kind, duration, registration type, tenant, agent.
-- The stamping behaviour itself is UNCHANGED (same condition, same repayment_starts_on default).
-- Logging can never block a submission: the insert is wrapped and a failure only raises a WARNING.
--
-- The function becomes SECURITY DEFINER so an agent's session can write the audit row (audit_logs is RLS-locked).
-- It is a trigger function, so no EXECUTE grant is needed or given. It is not in critical_function_baselines (no re-baseline).
-- The previous definition existed only in production (not in any migration file); it is restored verbatim by the rollback file.
-- Rollback: supabase/rollbacks/20261113090000_log_system_stamped_weekly_repayment_frequency.rollback.sql

CREATE OR REPLACE FUNCTION public.stamp_rent_request_repayment_frequency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_submitted  text := NEW.repayment_frequency;
  v_actor      uuid := auth.uid();
  v_self       boolean := COALESCE(NEW.tenant_self_applied, false);
  v_actor_kind text;
BEGIN
  IF public.rent_request_is_weekly_shape(NEW.duration_days, NEW.registration_type)
     AND lower(COALESCE(NEW.repayment_frequency, 'daily')) = 'daily' THEN
    NEW.repayment_frequency := 'weekly';

    -- Record the override. Never let logging stop a Rent Plan from being submitted.
    BEGIN
      v_actor_kind := CASE WHEN v_actor IS NOT NULL THEN 'person'
                           WHEN v_self THEN 'tenant_self_applied_via_service'
                           ELSE 'service' END;
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, reason, metadata)
      VALUES (
        COALESCE(v_actor, CASE WHEN v_self THEN NEW.tenant_id END),
        'repayment_frequency_set_weekly_by_system',
        'rent_requests',
        NEW.id::text,
        jsonb_build_object('repayment_frequency', v_submitted),
        jsonb_build_object('repayment_frequency', 'weekly'),
        'The system set this Rent Plan to weekly: the duration (' || COALESCE(NEW.duration_days::text, '?')
          || ' days) is a multiple of 7 and not 30, 60, 90 or 120, and the Rent Plan type (' || COALESCE(NEW.registration_type, 'normal')
          || ') is not outstanding_balance. It was submitted as ' || COALESCE(v_submitted, 'no frequency (default daily)') || '.',
        jsonb_build_object(
          'actor_kind', v_actor_kind,
          'submitted_frequency', v_submitted,
          'duration_days', NEW.duration_days,
          'registration_type', NEW.registration_type,
          'tenant_id', NEW.tenant_id,
          'agent_id', NEW.agent_id,
          'tenant_self_applied', v_self
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'stamp_rent_request_repayment_frequency: audit row skipped: %', SQLERRM;
    END;
  END IF;

  IF lower(COALESCE(NEW.repayment_frequency, 'daily')) = 'weekly'
     AND NEW.repayment_starts_on IS NULL THEN
    NEW.repayment_starts_on := (COALESCE(NEW.funded_at, NEW.created_at, now()) AT TIME ZONE 'Africa/Kampala')::date;
  END IF;
  RETURN NEW;
END;
$function$;
