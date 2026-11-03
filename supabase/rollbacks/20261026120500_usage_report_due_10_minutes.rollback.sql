DO $unpatch$
DECLARE
  f text; v_def text;
BEGIN
  FOREACH f IN ARRAY ARRAY['get_my_usage_report_notices','defer_requisition_usage_report','log_usage_report_notice_event'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = f AND p.pronamespace = 'public'::regnamespace;
    IF v_def IS NOT NULL AND position('interval ''10 minutes''' IN v_def) > 0 THEN
      EXECUTE replace(v_def, 'interval ''10 minutes''', 'interval ''36 hours''');
    END IF;
  END LOOP;
END
$unpatch$;
