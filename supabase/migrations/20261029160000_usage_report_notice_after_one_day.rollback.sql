-- Puts the accountability notice back to starting 10 minutes after the CFO approves.
DO $migration$
DECLARE
  r record;
  v_def text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('get_my_usage_report_notices', 2),
    ('defer_requisition_usage_report', 1),
    ('log_usage_report_notice_event', 1)
  ) AS t(fn, expected) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p WHERE p.proname = r.fn AND p.pronamespace = 'public'::regnamespace;
    IF v_def IS NULL THEN RAISE EXCEPTION '% not found. Nothing was changed.', r.fn; END IF;
    IF (length(v_def) - length(replace(v_def, 'interval ''1 day''', ''))) / length('interval ''1 day''') <> r.expected THEN
      RAISE EXCEPTION 'The live % is not the patched one. Nothing was changed.', r.fn;
    END IF;
    EXECUTE replace(v_def, 'interval ''1 day''', 'interval ''10 minutes''');
  END LOOP;
END
$migration$;
