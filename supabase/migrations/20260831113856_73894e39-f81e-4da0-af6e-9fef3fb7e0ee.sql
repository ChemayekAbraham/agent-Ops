-- 1. legacy outcome map
CREATE TABLE public.cc_legacy_outcome_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table text NOT NULL,
  source_value text NOT NULL,
  target_outcome public.cc_attempt_outcome NULL,
  note text NULL,
  UNIQUE (source_table, source_value)
);

GRANT SELECT ON public.cc_legacy_outcome_map TO authenticated;
GRANT ALL ON public.cc_legacy_outcome_map TO service_role;

ALTER TABLE public.cc_legacy_outcome_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cc_legacy_outcome_map_read"
ON public.cc_legacy_outcome_map FOR SELECT TO authenticated
USING (true);

CREATE POLICY "cc_legacy_outcome_map_admin_write"
ON public.cc_legacy_outcome_map FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'super_admin'))
WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- 2. populate from the actual distinct values present
INSERT INTO public.cc_legacy_outcome_map (source_table, source_value, target_outcome, note)
SELECT 'landlord_call_reports.status', v, NULL,
       'Unmapped: workflow status, not a call outcome. Map by hand.'
FROM (SELECT DISTINCT status::text AS v FROM public.landlord_call_reports WHERE status IS NOT NULL) s
ON CONFLICT (source_table, source_value) DO NOTHING;

INSERT INTO public.cc_legacy_outcome_map (source_table, source_value, target_outcome, note)
SELECT 'tenant_call_reports.outcome', v,
       CASE v
         WHEN 'picked_up' THEN 'engaged'::public.cc_attempt_outcome
         WHEN 'missed'    THEN 'no_answer'::public.cc_attempt_outcome
         ELSE NULL
       END,
       CASE v
         WHEN 'picked_up' THEN 'Call answered by the subject.'
         WHEN 'missed'    THEN 'Call not answered.'
         ELSE 'Unmapped: meaning unclear. Map by hand.'
       END
FROM (SELECT DISTINCT outcome::text AS v FROM public.tenant_call_reports WHERE outcome IS NOT NULL) s
ON CONFLICT (source_table, source_value) DO NOTHING;

INSERT INTO public.cc_legacy_outcome_map (source_table, source_value, target_outcome, note)
SELECT 'tenant_call_reports.status', v, NULL,
       'Unmapped: workflow status, not a call outcome. Map by hand.'
FROM (SELECT DISTINCT status::text AS v FROM public.tenant_call_reports WHERE status IS NOT NULL) s
ON CONFLICT (source_table, source_value) DO NOTHING;

-- legacy comment carrier
ALTER TABLE public.cc_call_attempts ADD COLUMN IF NOT EXISTS legacy_note text NULL;

-- 3. historical cycle 0 per subject type (closed: only one open cycle allowed)
INSERT INTO public.cc_call_cycles (subject_type, cycle_no, opened_at, opened_by, closed_at, retry_after_days, attempt_cap)
SELECT st,
       0,
       COALESCE(
         CASE st
           WHEN 'tenant'   THEN (SELECT min(called_at) FROM public.tenant_call_reports)
           WHEN 'landlord' THEN (SELECT min(called_at) FROM public.landlord_call_reports)
           ELSE NULL
         END, now()),
       (SELECT user_id FROM public.user_roles WHERE role = 'super_admin' LIMIT 1),
       now(), 3, 2
FROM (VALUES ('tenant'::public.cc_subject_type), ('landlord'::public.cc_subject_type), ('agent'::public.cc_subject_type)) v(st)
ON CONFLICT (subject_type, cycle_no) DO NOTHING;

-- 4. backfill with the Phase 1 triggers stood down
ALTER TABLE public.cc_call_attempts DISABLE TRIGGER trg_cc_attempt_before_insert;
ALTER TABLE public.cc_call_attempts DISABLE TRIGGER trg_cc_attempt_after_insert;
ALTER TABLE public.cc_call_attempts DISABLE TRIGGER trg_cc_attempt_after_record;
ALTER TABLE public.cc_call_attempts DISABLE TRIGGER trg_cc_attempt_requires_feedback;

-- 4a. cycle rows, tenant legacy
WITH mapped AS (
  SELECT r.tenant_id AS subject_id, r.called_at, m.target_outcome
  FROM public.tenant_call_reports r
  JOIN public.cc_legacy_outcome_map m
    ON m.source_table = 'tenant_call_reports.outcome'
   AND m.source_value = r.outcome::text
  WHERE m.target_outcome IS NOT NULL
    AND r.tenant_id IS NOT NULL
), agg AS (
  SELECT subject_id, count(*) AS attempts, max(called_at) AS last_at,
         bool_or(target_outcome = 'engaged') AS any_engaged
  FROM mapped GROUP BY subject_id
)
INSERT INTO public.cc_cycle_rows (cycle_id, subject_type, subject_id, state, attempts_made, last_attempt_at, priority_value, closed_at)
SELECT c.id, 'tenant'::public.cc_subject_type, a.subject_id,
       CASE WHEN a.any_engaged THEN 'engaged'::public.cc_row_state ELSE 'unreachable'::public.cc_row_state END,
       a.attempts, a.last_at, NULL, now()
FROM agg a
CROSS JOIN (SELECT id FROM public.cc_call_cycles WHERE subject_type = 'tenant' AND cycle_no = 0) c
ON CONFLICT (cycle_id, subject_type, subject_id) DO NOTHING;

-- 4a. cycle rows, landlord legacy
WITH mapped AS (
  SELECT r.landlord_id AS subject_id, r.called_at, m.target_outcome
  FROM public.landlord_call_reports r
  JOIN public.cc_legacy_outcome_map m
    ON m.source_table = 'landlord_call_reports.status'
   AND m.source_value = r.status::text
  WHERE m.target_outcome IS NOT NULL
    AND r.landlord_id IS NOT NULL
), agg AS (
  SELECT subject_id, count(*) AS attempts, max(called_at) AS last_at,
         bool_or(target_outcome = 'engaged') AS any_engaged
  FROM mapped GROUP BY subject_id
)
INSERT INTO public.cc_cycle_rows (cycle_id, subject_type, subject_id, state, attempts_made, last_attempt_at, priority_value, closed_at)
SELECT c.id, 'landlord'::public.cc_subject_type, a.subject_id,
       CASE WHEN a.any_engaged THEN 'engaged'::public.cc_row_state ELSE 'unreachable'::public.cc_row_state END,
       a.attempts, a.last_at, NULL, now()
FROM agg a
CROSS JOIN (SELECT id FROM public.cc_call_cycles WHERE subject_type = 'landlord' AND cycle_no = 0) c
ON CONFLICT (cycle_id, subject_type, subject_id) DO NOTHING;

-- 4b. attempts, tenant legacy
WITH mapped AS (
  SELECT r.id, r.tenant_id, r.called_at, r.called_by, r.comment, m.target_outcome,
         row_number() OVER (PARTITION BY r.tenant_id ORDER BY r.called_at, r.id) AS attempt_no
  FROM public.tenant_call_reports r
  JOIN public.cc_legacy_outcome_map m
    ON m.source_table = 'tenant_call_reports.outcome'
   AND m.source_value = r.outcome::text
  WHERE m.target_outcome IS NOT NULL
    AND r.tenant_id IS NOT NULL
    AND r.called_by IS NOT NULL
)
INSERT INTO public.cc_call_attempts (
  cycle_row_id, attempt_no, caller_id, revealed_at, recorded_at, outcome, channel, source, legacy_note
)
SELECT cr.id, mp.attempt_no, mp.called_by, mp.called_at, mp.called_at, mp.target_outcome,
       'phone', 'legacy_backfill', mp.comment
FROM mapped mp
JOIN public.cc_call_cycles c ON c.subject_type = 'tenant' AND c.cycle_no = 0
JOIN public.cc_cycle_rows cr ON cr.cycle_id = c.id AND cr.subject_id = mp.tenant_id
ON CONFLICT (cycle_row_id, attempt_no) DO NOTHING;

-- 4b. attempts, landlord legacy
WITH mapped AS (
  SELECT r.id, r.landlord_id, r.called_at, r.called_by, r.comment, m.target_outcome,
         row_number() OVER (PARTITION BY r.landlord_id ORDER BY r.called_at, r.id) AS attempt_no
  FROM public.landlord_call_reports r
  JOIN public.cc_legacy_outcome_map m
    ON m.source_table = 'landlord_call_reports.status'
   AND m.source_value = r.status::text
  WHERE m.target_outcome IS NOT NULL
    AND r.landlord_id IS NOT NULL
    AND r.called_by IS NOT NULL
)
INSERT INTO public.cc_call_attempts (
  cycle_row_id, attempt_no, caller_id, revealed_at, recorded_at, outcome, channel, source, legacy_note
)
SELECT cr.id, mp.attempt_no, mp.called_by, mp.called_at, mp.called_at, mp.target_outcome,
       'phone', 'legacy_backfill', mp.comment
FROM mapped mp
JOIN public.cc_call_cycles c ON c.subject_type = 'landlord' AND c.cycle_no = 0
JOIN public.cc_cycle_rows cr ON cr.cycle_id = c.id AND cr.subject_id = mp.landlord_id
ON CONFLICT (cycle_row_id, attempt_no) DO NOTHING;

ALTER TABLE public.cc_call_attempts ENABLE TRIGGER trg_cc_attempt_before_insert;
ALTER TABLE public.cc_call_attempts ENABLE TRIGGER trg_cc_attempt_after_insert;
ALTER TABLE public.cc_call_attempts ENABLE TRIGGER trg_cc_attempt_after_record;
ALTER TABLE public.cc_call_attempts ENABLE TRIGGER trg_cc_attempt_requires_feedback;

DO $$
DECLARE v_off int;
BEGIN
  SELECT count(*) INTO v_off
  FROM pg_trigger
  WHERE tgrelid = 'public.cc_call_attempts'::regclass
    AND NOT tgisinternal
    AND tgenabled = 'D';
  IF v_off > 0 THEN
    RAISE EXCEPTION 'Backfill left % trigger(s) disabled on cc_call_attempts.', v_off;
  END IF;
END $$;

-- 5. freeze the legacy tables
CREATE OR REPLACE FUNCTION public.cc_freeze_legacy_call_table()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'This table is frozen. Log calls through cc_call_attempts.';
END;
$function$;

CREATE TRIGGER trg_landlord_call_reports_frozen
BEFORE INSERT OR UPDATE ON public.landlord_call_reports
FOR EACH ROW EXECUTE FUNCTION public.cc_freeze_legacy_call_table();

CREATE TRIGGER trg_tenant_call_reports_frozen
BEFORE INSERT OR UPDATE ON public.tenant_call_reports
FOR EACH ROW EXECUTE FUNCTION public.cc_freeze_legacy_call_table();