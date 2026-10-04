-- CRM Call Centre — stop in-flight calls stranding forever.
--
-- `crm_call_sessions` rows are settled ONLY by Africa's Talking' terminal
-- callback. If that callback never arrives — misconfigured callback URL, an AT
-- outage, a dropped webhook — the row keeps its live status permanently: it
-- shows as "In progress" in People / Calls and inflates the in-progress KPI
-- with no way to ever clear it. The frontend cannot fix this: it is not
-- permitted to write telephony state.
--
-- Two complementary fixes:
--   1. crm_sweep_stale_calls()      — ages out rows nothing will ever settle.
--   2. crm_record_call_outcome()    — lets staff record a failure the provider
--                                     cannot know, but ONLY while the row is
--                                     still live, so provider truth always wins.

-- ---------------------------------------------------------------------------
-- 1. Sweeper
-- ---------------------------------------------------------------------------

/**
 * Age out call rows that no callback will ever settle.
 *
 * Two thresholds, because the two phases have very different natural lifetimes:
 *
 *  - PRE-ANSWER (initiating/queued/ringing/ringing_staff): a handset either
 *    answers or gives up within a minute or two. Anything still ringing after
 *    `p_ringing_grace` is dead.
 *  - CONNECTED (bridged/active/in_progress): a real conversation can legitimately
 *    run long, so this gets a much wider window. Sweeping these on the same short
 *    timer would kill calls that are still genuinely on the line.
 *
 * Swept rows are marked `expired` + `CALLBACK_TIMEOUT`, which deriveOutcome()
 * maps to "not reachable". That is deliberate: for a stranded row we do NOT know
 * the customer was reached, and the safe direction is never to invent an answer,
 * which would inflate the answer rate and (for a zero-duration row) drag down
 * average talk time. `failure_reason` records why, so a swept row stays
 * distinguishable from a genuine no-answer in an audit.
 *
 * Returns the number of rows swept. Idempotent — already-settled rows are
 * untouched, so re-running is safe.
 */
CREATE OR REPLACE FUNCTION public.crm_sweep_stale_calls(
  p_ringing_grace   interval DEFAULT '15 minutes',
  p_connected_grace interval DEFAULT '4 hours'
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_swept integer;
BEGIN
  UPDATE public.crm_call_sessions
     SET status          = 'expired',
         hangup_cause    = COALESCE(hangup_cause, 'CALLBACK_TIMEOUT'),
         duration_seconds = COALESCE(duration_seconds, 0),
         failure_reason  = COALESCE(
           failure_reason,
           'swept: no provider callback received'
         )
   WHERE status IN (
           'initiating', 'queued', 'ringing', 'ringing_staff',
           'bridged', 'active', 'in_progress'
         )
     AND (
           -- Pre-answer legs die quickly.
           (status IN ('initiating', 'queued', 'ringing', 'ringing_staff')
             AND created_at < now() - p_ringing_grace)
           -- Connected legs get a much longer rope.
        OR (status IN ('bridged', 'active', 'in_progress')
             AND created_at < now() - p_connected_grace)
         );

  GET DIAGNOSTICS v_swept = ROW_COUNT;
  RETURN v_swept;
END;
$$;

-- Service role (cron) only. Staff never call this directly.
REVOKE ALL ON FUNCTION public.crm_sweep_stale_calls(interval, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_sweep_stale_calls(interval, interval) TO service_role;

-- Run it in-database rather than via net.http_post: this is pure SQL, so a
-- round trip through the REST API (and an embedded anon JWT) buys nothing.
-- Re-runnable: drop any existing job first, tolerating both "job absent" and
-- "cron.job not readable" (repo idiom).
DO $cron$
BEGIN
  BEGIN
    PERFORM cron.unschedule('crm-sweep-stale-calls');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'crm-sweep-stale-calls',
    '*/10 * * * *',
    $$SELECT public.crm_sweep_stale_calls()$$
  );
END
$cron$;

-- ---------------------------------------------------------------------------
-- 2. Manual outcome override
-- ---------------------------------------------------------------------------

/**
 * Record a failure outcome the provider cannot report.
 *
 * The staff member can see things Africa's Talking cannot — the customer picked
 * up and immediately refused, or it is plainly a wrong number. This is the write
 * path behind the "They rejected" / "Not reachable" buttons, which until now
 * changed local UI state and nothing else.
 *
 * Guard rails:
 *  - Role-gated exactly like the rest of the Call Centre surface.
 *  - Only applies while the row is STILL LIVE. The provider is the authority on
 *    how a call ended, so a terminal callback that has already landed is never
 *    overwritten by a human assertion.
 *  - Cannot be used to claim a call was answered: talk time is the provider's to
 *    report, and letting staff assert it would corrupt the answer rate and the
 *    average-talk-time figure.
 */
CREATE OR REPLACE FUNCTION public.crm_record_call_outcome(
  p_session_id uuid,
  p_outcome    text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_status text;
  v_cause  text;
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- 'answered' is deliberately NOT accepted — see the guard rails above.
  CASE p_outcome
    WHEN 'rejected'      THEN v_status := 'completed'; v_cause := 'CALL_REJECTED';
    WHEN 'not_reachable' THEN v_status := 'no_answer'; v_cause := 'NO_ANSWER';
    ELSE RAISE EXCEPTION 'invalid_outcome';
  END CASE;

  UPDATE public.crm_call_sessions
     SET status           = v_status,
         hangup_cause     = v_cause,
         duration_seconds = COALESCE(duration_seconds, 0),
         failure_reason   = COALESCE(failure_reason, 'recorded by staff')
   WHERE id = p_session_id
     -- Live only. A settled row keeps whatever the provider said.
     AND status IN (
           'initiating', 'queued', 'ringing', 'ringing_staff',
           'bridged', 'active', 'in_progress'
         );

  -- Deliberately silent when the row was already settled: the provider won the
  -- race, which is the correct outcome, not an error worth surfacing to staff.
END;
$$;

REVOKE ALL ON FUNCTION public.crm_record_call_outcome(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_record_call_outcome(uuid, text) TO authenticated;
