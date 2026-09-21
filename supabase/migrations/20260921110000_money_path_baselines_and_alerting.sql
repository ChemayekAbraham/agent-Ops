-- Close the two gaps that let 2026-09-10 and 2026-09-16 happen.
--
-- PROPOSED - NOT YET APPLIED. Read-only in effect: it moves no money, posts no
-- ledger row, touches no wallet and changes no money-path behaviour. It only
-- makes an unreviewed production edit of the money path VISIBLE.
--
-- THE HISTORY THIS EXISTS FOR
--   2026-09-10 07:29 EAT  New `p_client_ref` overloads of
--                         agent_allocate_tenant_payment[_internal] were
--                         deployed straight to production with no migration.
--                         They inverted BOTH collection legs; the guard had
--                         been edited to expect the inverted direction and so
--                         waved them through. 16 collections, 3 agents,
--                         UGX 6,064,036 of float wrongly credited,
--                         UGX 606,403.60 commission, UGX 183,334.80 written off.
--   2026-09-15 15:12 UTC  drizzle 0114 rewrote the same function in production.
--                         Float stopped being consumed, three controls failed
--                         together, and nothing noticed for 16 HOURS.
--                         1,616 collections / 249 plans, UGX 97,489,004
--                         duplicated, ~UGX 9.7M commission overpaid across 31
--                         agents, UGX 7.7M withdrawn before it was caught.
--
-- Both migrations that cleaned up after these said the same thing:
--   "money-path RPCs and their guards must not be deployed outside a reviewed
--    migration"  (20260910100000)
--   "A rule nothing enforces is a wish."  (20260916190000)
--
-- GAP 1 - THE MOST-DRIFTED FUNCTION IN THE SYSTEM IS NOT BASELINED
-- `scan_critical_function_drift()` runs every 15 minutes, hashes each function
-- in `critical_function_baselines` against its live definition, and raises a
-- `critical_function_drift_detected` system_event when they differ. It works.
-- But the baseline table holds 12 functions and NONE of them is
-- agent_allocate_tenant_payment_internal, its wrapper, its guard, the
-- commission rate function, or the money-path assertion itself - that is,
-- none of the functions that actually drifted, twice, at a cost of UGX 100m+.
-- Step 1 baselines them.
--
-- GAP 2 - THE MONEY-PATH DETECTOR LOGS WHERE NOBODY LOOKS
-- `record_money_path_drift()` runs every 10 minutes and inserts failures into
-- `money_path_drift_events`. Nothing reads that table: no function, no edge
-- function, no frontend file references it (only the generated types.ts).
-- `scan_critical_function_drift` emits a system_event; this one does not, so a
-- money-path invariant can break and the only trace is a row in a table no
-- alert is wired to. Step 2 gives it the same voice.
--
-- HOW THIS PREVENTS A RECURRENCE
-- After this, changing any money-path function WITHOUT a migration moves its
-- hash while the baseline stays put, and an alert fires within 15 minutes. A
-- legitimate change updates the baseline in the SAME reviewed migration - see
-- 20260921120000, which does exactly that. The discipline becomes detectable
-- rather than merely written down.

BEGIN;

-- 0. Refuse to baseline a money path that is already broken -----------------
-- Baselining blindly would freeze a tampered definition as "expected". Only
-- proceed from a state that assert_money_path_intact() certifies as clean.
DO $guard$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(check_name, ', ')
    INTO v_failed
    FROM public.assert_money_path_intact()
   WHERE NOT ok;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to baseline: assert_money_path_intact() is already failing (%). Fix the money path first.',
      v_failed
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

-- 1. Baseline the money-path functions --------------------------------------
DO $baseline$
DECLARE
  v_sig  text;
  v_note text;
  v_sigs text[] := ARRAY[
    'agent_allocate_tenant_payment_internal(uuid,uuid,uuid,numeric,text,uuid)',
    'agent_allocate_tenant_payment(uuid,uuid,uuid,numeric,text,boolean,text,uuid)',
    'guard_rent_request_agent_updates()',
    'get_agent_commission_rate(uuid)',
    'assert_money_path_intact()'
  ];
  v_notes text[] := ARRAY[
    'rewritten in production 2026-09-10 and 2026-09-15; both cost real money',
    'the 2026-09-10 incident arrived as a new overload of this wrapper',
    'edited to match the bug on 2026-09-10 - a guard that is edited to match a bug stops being a guard',
    'single source of truth for the 10%/8%+2% split; the screen and the wallet must agree',
    'the detector itself: weakening a check must be as visible as weakening the code'
  ];
BEGIN
  FOR i IN 1 .. array_length(v_sigs, 1) LOOP
    v_sig  := v_sigs[i];
    v_note := v_notes[i];

    -- Skip rather than fail if a signature is absent, so this migration stays
    -- safe to run against a database where an overload differs.
    BEGIN
      PERFORM v_sig::regprocedure;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'skipping baseline, signature not found: %', v_sig;
      CONTINUE;
    END;

    DELETE FROM public.critical_function_baselines WHERE function_signature = v_sig;

    INSERT INTO public.critical_function_baselines
      (function_signature, expected_sha256, note, baselined_by)
    VALUES (
      v_sig,
      encode(sha256(convert_to(pg_get_functiondef(v_sig::regprocedure), 'UTF8')), 'hex'),
      v_note,
      'migration 20260921110000'
    );
  END LOOP;
END
$baseline$;

-- 2. Give the money-path detector the same voice as the hash detector -------
-- Unchanged behaviour except the system_events emission on a NEW unresolved
-- failure. The insert is wrapped so that an alerting problem can never stop
-- drift from being recorded.
CREATE OR REPLACE FUNCTION public.record_money_path_drift()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new integer := 0;
  v_rec record;
BEGIN
  INSERT INTO public.money_path_drift_events (check_name, detail)
  SELECT c.check_name, c.detail FROM public.assert_money_path_intact() c
   WHERE NOT c.ok AND NOT EXISTS (SELECT 1 FROM public.money_path_drift_events e
                                   WHERE e.check_name=c.check_name AND e.resolved_at IS NULL);
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- NEW: alert, do not merely log. Without this a money-path invariant can
  -- break and leave no trace anywhere anyone watches - which is how the
  -- 2026-09-15 rewrite ran unnoticed for 16 hours.
  IF v_new > 0 THEN
    BEGIN
      FOR v_rec IN
        SELECT e.check_name, e.detail
          FROM public.money_path_drift_events e
         WHERE e.resolved_at IS NULL
           AND e.detected_at >= now() - interval '1 minute'
      LOOP
        INSERT INTO public.system_events (event_type, metadata)
        VALUES (
          'money_path_drift_detected',
          jsonb_build_object(
            'check_name',  v_rec.check_name,
            'detail',      v_rec.detail,
            'detected_at', now()
          )
        );
      END LOOP;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  UPDATE public.money_path_drift_events e SET resolved_at = now()
   WHERE e.resolved_at IS NULL
     AND EXISTS (SELECT 1 FROM public.assert_money_path_intact() c WHERE c.check_name=e.check_name AND c.ok);
  RETURN v_new;
END;
$function$;

COMMIT;
