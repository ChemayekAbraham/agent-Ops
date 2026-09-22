-- Permanent fix for the recurring email_queue_dispatch self-cancel regression
-- (docs/HANDOVER/18, 84, 88, 101 -- six occurrences between 2026-09-13 and
-- 2026-09-22, ~90 minutes to 4 days apart, always reverting the live function
-- body straight against production with zero migration file ever recording
-- the revert -- see doc 101's "still unexplained" note and doc 18's original
-- finding). Every occurrence needed a human to notice the drift alert and
-- manually re-apply the exact same fix. This closes that loop.
--
-- critical_function_baselines (20260914120000) already detects this drift
-- within 15 minutes, but only ever alerts -- it never had the correct
-- function body on hand to restore, only a hash. This adds that: a stored
-- canonical_body per baselined function, and an auto_remediate flag. When
-- scan_critical_function_drift() finds a mismatch on a row with
-- auto_remediate = true, it now re-executes the stored canonical_body
-- immediately (CREATE OR REPLACE is idempotent and safe to replay) and only
-- falls back to the old alert-only behavior if that doesn't actually restore
-- the expected hash.
--
-- Deliberately enabled ONLY for email_queue_dispatch(): its "correct" design
-- has been unchanged and unambiguous across five prior fixes (never
-- self-cancel; poll forever), and the failure mode of auto-remediation itself
-- misfiring is "keeps polling every 5 seconds", not a money-movement risk.
-- The other five baselined functions (withdrawal gate, payout destination,
-- interest authorization, etc.) are NOT auto_remediate -- a deliberate future
-- change to one of those must still go through a human re-baseline, per the
-- existing rule in docs/HANDOVER (re-baseline in the SAME migration you
-- change the function in). Turning on auto-remediation there would silently
-- fight a legitimate change.
--
-- IMPORTANT for whoever deliberately changes email_queue_dispatch itself in
-- future: update canonical_body AND expected_sha256 together in that same
-- migration, or this scanner will revert the deliberate change back within
-- one scan interval.

ALTER TABLE public.critical_function_baselines
  ADD COLUMN canonical_body text,
  ADD COLUMN auto_remediate boolean NOT NULL DEFAULT false;

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
  v_remediated jsonb := '[]'::jsonb;
  v_existing_alert uuid;
  v_post_remediation_hash text;
BEGIN
  FOR rec IN SELECT function_signature, expected_sha256, canonical_body, auto_remediate
             FROM public.critical_function_baselines
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

      v_post_remediation_hash := NULL;
      IF rec.auto_remediate AND rec.canonical_body IS NOT NULL THEN
        BEGIN
          EXECUTE rec.canonical_body;
          v_post_remediation_hash := encode(sha256(convert_to(
            pg_get_functiondef(rec.function_signature::regprocedure), 'UTF8')), 'hex');
        EXCEPTION WHEN OTHERS THEN
          v_post_remediation_hash := NULL;
        END;
      END IF;

      IF v_post_remediation_hash IS NOT NULL AND v_post_remediation_hash = rec.expected_sha256 THEN
        -- Healed within this scan. Recorded as an already-resolved alert so
        -- the revert+heal episode still shows up in the audit trail, without
        -- needing a human to act on it.
        INSERT INTO public.critical_function_drift_alerts (
          function_signature, expected_sha256, actual_sha256, resolved_at, resolution_note
        ) VALUES (
          rec.function_signature, rec.expected_sha256, v_actual_hash, now(),
          'auto-remediated: canonical body re-applied by scan_critical_function_drift()'
        );

        v_remediated := v_remediated || jsonb_build_object(
          'function_signature', rec.function_signature,
          'actual_sha256_before', v_actual_hash
        );

        BEGIN
          INSERT INTO public.system_events (event_type, metadata)
          VALUES (
            'critical_function_drift_auto_remediated',
            jsonb_build_object(
              'function_signature', rec.function_signature,
              'actual_sha256_before', v_actual_hash,
              'expected_sha256', rec.expected_sha256,
              'remediated_at', now()
            )
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;

      ELSE
        -- Not eligible for auto-remediation, or the remediation attempt
        -- itself did not produce the expected hash -- fall back to the
        -- original alert-only behavior so a human still gets pinged.
        v_drifted := v_drifted || jsonb_build_object(
          'function_signature', rec.function_signature,
          'expected_sha256', rec.expected_sha256,
          'actual_sha256', v_actual_hash,
          'auto_remediate_attempted', (rec.auto_remediate AND rec.canonical_body IS NOT NULL)
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
    'remediated_count', jsonb_array_length(v_remediated),
    'remediated', v_remediated,
    'ran_at', now()
  );
END;
$function$;

-- Store the current (verified-correct, sixth-fix) body as the canonical
-- definition to auto-restore, and turn on auto-remediation for this function
-- only. expected_sha256 is left as-is -- it already matches this exact body
-- (re-baselined by doc 101 at 2026-09-22 04:43:58 UTC).
--
-- Pulled live via pg_get_functiondef() rather than hand-transcribed: a
-- hand-typed copy of this body hashed differently from expected_sha256
-- (whitespace/line-ending drift from transcription) when this migration was
-- first drafted and applied -- exactly the kind of silent mismatch that
-- would have made every future remediation attempt look like it failed
-- (v_post_remediation_hash never equal to expected_sha256) even though the
-- function itself was correctly restored. Always derive canonical_body from
-- the live function, never type it out by hand.
UPDATE public.critical_function_baselines
SET auto_remediate = true,
    canonical_body = pg_get_functiondef('email_queue_dispatch()'::regprocedure)
WHERE function_signature = 'email_queue_dispatch()';

-- Tighten the scan cadence from 15 to 5 minutes. The scan is cheap (a hash
-- of ~6 small function bodies), and a faster cadence directly shrinks the
-- worst-case window a revert (auto-remediated or not) can sit live.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'scan-critical-function-drift'),
  schedule := '*/5 * * * *'
);
