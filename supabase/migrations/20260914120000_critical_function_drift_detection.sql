-- Safeguard against the exact failure mode found 2026-09-14: the fix to
-- email_queue_dispatch() (self-cancel removal, migration 20260913140000)
-- was confirmed live, then reverted directly against production sometime
-- before the next CTO report ran -- with no migration file recording the
-- revert. It sat broken again for hours before anyone noticed, purely
-- because nothing was watching for the live function body to change out
-- from under its last known-good migration.
--
-- This baselines a small, deliberately curated set of security/money-
-- movement-critical functions by the sha256 of their pg_get_functiondef()
-- output, and scans every 15 minutes for any live function whose body no
-- longer matches what was last deliberately set. Detected drift is both
-- recorded (so it survives past the scan that found it) and pushed into
-- system_events for whatever already watches that table.
--
-- Extending coverage later is a data change, not a code change: insert a
-- row into critical_function_baselines with the function's exact
-- regprocedure signature and the sha256 of its current (correct)
-- pg_get_functiondef() output.

CREATE TABLE public.critical_function_baselines (
  function_signature text PRIMARY KEY,
  expected_sha256 text NOT NULL,
  note text,
  baselined_at timestamptz NOT NULL DEFAULT now(),
  baselined_by text
);

CREATE TABLE public.critical_function_drift_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_signature text NOT NULL,
  expected_sha256 text NOT NULL,
  actual_sha256 text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text
);

-- One active (unresolved) alert per function at a time -- repeated scans
-- while a drift is ongoing must not spam a new row every 15 minutes.
CREATE UNIQUE INDEX idx_critical_function_drift_alerts_active
  ON public.critical_function_drift_alerts (function_signature)
  WHERE resolved_at IS NULL;

ALTER TABLE public.critical_function_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.critical_function_drift_alerts ENABLE ROW LEVEL SECURITY;
-- RLS enabled, deliberately zero policies -- these are read/written by
-- scan_critical_function_drift() (SECURITY DEFINER) and by migrations
-- (which run as the table owner), never by client-facing PostgREST calls.

CREATE OR REPLACE FUNCTION public.scan_critical_function_drift()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  rec record;
  v_oid oid;
  v_actual_hash text;
  v_checked int := 0;
  v_drifted jsonb := '[]'::jsonb;
  v_existing_alert uuid;
BEGIN
  FOR rec IN SELECT function_signature, expected_sha256 FROM public.critical_function_baselines
  LOOP
    v_checked := v_checked + 1;
    v_actual_hash := NULL;

    BEGIN
      v_oid := rec.function_signature::regprocedure;
      -- text::bytea does NOT UTF-8-encode the string -- it parses it as a
      -- bytea literal (hex/octal escapes), which silently corrupts almost
      -- any function body. convert_to(..., 'UTF8') is the correct way to
      -- get the actual byte representation to hash.
      v_actual_hash := encode(sha256(convert_to(pg_get_functiondef(v_oid), 'UTF8')), 'hex');
    EXCEPTION WHEN OTHERS THEN
      -- Function signature no longer resolves at all (dropped, renamed,
      -- signature changed) -- that is itself drift, worth flagging with a
      -- NULL actual hash rather than silently skipping it.
      v_actual_hash := NULL;
    END;

    IF v_actual_hash IS DISTINCT FROM rec.expected_sha256 THEN
      v_drifted := v_drifted || jsonb_build_object(
        'function_signature', rec.function_signature,
        'expected_sha256', rec.expected_sha256,
        'actual_sha256', v_actual_hash
      );

      SELECT id INTO v_existing_alert
      FROM public.critical_function_drift_alerts
      WHERE function_signature = rec.function_signature AND resolved_at IS NULL;

      IF v_existing_alert IS NULL THEN
        INSERT INTO public.critical_function_drift_alerts (
          function_signature, expected_sha256, actual_sha256
        ) VALUES (
          rec.function_signature, rec.expected_sha256, v_actual_hash
        );

        BEGIN
          INSERT INTO public.system_events (event_type, metadata)
          VALUES (
            'critical_function_drift_detected',
            jsonb_build_object(
              'function_signature', rec.function_signature,
              'expected_sha256', rec.expected_sha256,
              'actual_sha256', v_actual_hash,
              'detected_at', now()
            )
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
    ELSE
      -- Hash matches the baseline again -- auto-resolve any alert left over
      -- from an earlier drift that has since been corrected.
      UPDATE public.critical_function_drift_alerts
         SET resolved_at = now(),
             resolution_note = 'auto-resolved: live function hash matches baseline again'
       WHERE function_signature = rec.function_signature AND resolved_at IS NULL;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'checked', v_checked,
    'drifted_count', jsonb_array_length(v_drifted),
    'drifted', v_drifted,
    'ran_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.scan_critical_function_drift() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scan_critical_function_drift() TO service_role;

SELECT cron.schedule(
  'scan-critical-function-drift',
  '*/15 * * * *',
  $cron$ SELECT public.scan_critical_function_drift(); $cron$
);

-- Seed the initial baseline: the six functions touched in today's
-- money-movement / security work, hashed from their current (correct,
-- just-verified) live bodies.
INSERT INTO public.critical_function_baselines (function_signature, expected_sha256, note, baselined_by)
SELECT sig, encode(sha256(convert_to(pg_get_functiondef(sig::regprocedure), 'UTF8')), 'hex'), note, '20260914120000_critical_function_drift_detection.sql'
FROM (VALUES
  ('email_queue_dispatch()', 'Self-cancel regression found 2026-09-14 -- reverted directly against prod once already, no migration recorded the revert.'),
  ('submit_withdrawal_request(numeric,text,text,text,text,text,text,text,uuid,text)', 'Core withdrawal gate: balance check + Financial-Ops destination verification. The single most critical function in this set.'),
  ('ensure_payout_destination(uuid,text,text,text,text,text,text,text)', 'Registers/checks payout destination verification status; the NIN name-match pipeline depends on this.'),
  ('apply_welile_homes_monthly_interest()', 'Had zero authorization check and was executable by anon until fixed 2026-09-14 -- watch for that gate disappearing again.'),
  ('enforce_withdrawal_payout_account_lock()', 'Trigger: blocks changing an already-registered payout number on withdrawal_requests.'),
  ('enforce_withdrawal_destination_verified()', 'Trigger: blocks a self-service withdrawal to an unverified destination.')
) AS t(sig, note);
