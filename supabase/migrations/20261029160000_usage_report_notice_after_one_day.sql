-- Requisition accountability (usage report) notice: it starts 1 day after the CFO approves and pays, not 10 minutes.
--
-- Three functions use the same wait, and all three must agree or the notice would show but could not be deferred or acknowledged:
--   * get_my_usage_report_notices      : who is shown the notice (and grace_ends_at), 2 places
--   * defer_requisition_usage_report   : "Not due yet" check before a deferral
--   * log_usage_report_notice_event    : "Not due yet" check before shown / acknowledged is recorded
-- Each is patched in place from the live definition: "interval '10 minutes'" becomes "interval '1 day'". The number of places is checked for each function;
-- if the live function is not what is expected, the migration stops and writes nothing.
-- Nothing else changes: who is asked, the two deferrals, the mandatory notice after them, reports already filed and reversed payments are all as before.
-- Roll back with 20261029160000_usage_report_notice_after_one_day.rollback.sql.

DO $migration$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('get_my_usage_report_notices', 2),
    ('defer_requisition_usage_report', 1),
    ('log_usage_report_notice_event', 1)
  ) AS t(fn, expected) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p WHERE p.proname = r.fn AND p.pronamespace = 'public'::regnamespace;
    IF v_def IS NULL THEN RAISE EXCEPTION '% not found. Nothing was changed.', r.fn; END IF;
    IF (length(v_def) - length(replace(v_def, 'interval ''10 minutes''', ''))) / length('interval ''10 minutes''') <> r.expected THEN
      RAISE EXCEPTION 'The live % is not the expected one (the 10 minute wait is not in % place(s)). Nothing was changed.', r.fn, r.expected;
    END IF;
    v_new := replace(v_def, 'interval ''10 minutes''', 'interval ''1 day''');
    EXECUTE v_new;
  END LOOP;
END
$migration$;
