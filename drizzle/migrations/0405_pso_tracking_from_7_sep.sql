-- Platform Sales Officer tracking starts 7 Sep 2026 for every officer, whatever their HR enrolment date.
-- HR start dates (officer_since) are unchanged; only the reporting cut-off moves. Decision: HR Lead, 2 Oct 2026.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled') THEN
    RAISE EXCEPTION 'FINGERPRINT FAIL: not the RentFlow database';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.pso_tracking_start()
RETURNS date LANGUAGE sql IMMUTABLE AS $f$ SELECT date '2026-09-07' $f$;

DO $patch$
DECLARE
  d text;
  FUNCTION_ANCHOR_COUNT int;
BEGIN
  -- 1. v_pso_officers: add tracking_since (earlier of HR start and 7 Sep)
  d := pg_get_viewdef('public.v_pso_officers'::regclass, true);
  IF (length(d) - length(replace(d, 'min(a.started_on) AS officer_since', ''))) / length('min(a.started_on) AS officer_since') <> 1 THEN
    RAISE EXCEPTION 'v_pso_officers anchor not found exactly once';
  END IF;
  d := replace(d, 'min(a.started_on) AS officer_since',
                  'min(a.started_on) AS officer_since, LEAST(min(a.started_on), pso_tracking_start()) AS tracking_since');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_pso_officers WITH (security_invoker = on) AS ' || d;

  -- 2. v_pso_note_events: pre-enrolment measured against tracking_since
  d := pg_get_viewdef('public.v_pso_note_events'::regclass, true);
  IF (length(d) - length(replace(d, '< o.officer_since AS pre_enrolment', ''))) / length('< o.officer_since AS pre_enrolment') <> 1 THEN
    RAISE EXCEPTION 'v_pso_note_events anchor not found exactly once';
  END IF;
  d := replace(d, '< o.officer_since AS pre_enrolment', '< o.tracking_since AS pre_enrolment');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_pso_note_events WITH (security_invoker = on) AS ' || d;

  -- 3. v_pso_conversions: same rule for conversions
  d := pg_get_viewdef('public.v_pso_conversions'::regclass, true);
  IF (length(d) - length(replace(d, '< o.officer_since AS from_pre_enrolment_note', ''))) / length('< o.officer_since AS from_pre_enrolment_note') <> 1 THEN
    RAISE EXCEPTION 'v_pso_conversions anchor not found exactly once';
  END IF;
  d := replace(d, '< o.officer_since AS from_pre_enrolment_note', '< o.tracking_since AS from_pre_enrolment_note');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_pso_conversions WITH (security_invoker = on) AS ' || d;

  -- 4. pso_daily_series: daily chart starts at tracking_since, not HR start
  d := pg_get_functiondef('public.pso_daily_series'::regproc);
  IF position('select o.staff_id, o.staff_ref, o.officer_since' in d) = 0
     OR position('greatest(p_from, c.officer_since)' in d) = 0 THEN
    RAISE EXCEPTION 'pso_daily_series anchors not found';
  END IF;
  d := replace(d, 'select o.staff_id, o.staff_ref, o.officer_since', 'select o.staff_id, o.staff_ref, o.tracking_since');
  d := replace(d, 'greatest(p_from, c.officer_since)', 'greatest(p_from, c.tracking_since)');
  EXECUTE d;
END $patch$;

SELECT o.staff_ref, o.officer_since, o.tracking_since,
       count(e.*) FILTER (WHERE NOT e.pre_enrolment AND e.reversed_at IS NULL AND e.note_status = 'activated') AS notes_counted
  FROM public.v_pso_officers o
  LEFT JOIN public.v_pso_note_events e ON e.staff_id = o.staff_id
 GROUP BY 1,2,3 ORDER BY 1;