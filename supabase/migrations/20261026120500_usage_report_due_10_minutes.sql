-- Usage report notice: due 10 minutes after the CFO approves and pays the requisition (was 36 hours).
-- Patches the three functions that share the due-time test so the list, "put off" and the notice log agree.
DO $patch$
DECLARE
  f text; v_def text; n int;
BEGIN
  FOREACH f IN ARRAY ARRAY['get_my_usage_report_notices','defer_requisition_usage_report','log_usage_report_notice_event'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = f AND p.pronamespace = 'public'::regnamespace;
    IF v_def IS NULL OR position('interval ''36 hours''' IN v_def) = 0 THEN
      RAISE EXCEPTION '% changed: no 36 hours found, nothing was changed', f;
    END IF;
    EXECUTE replace(v_def, 'interval ''36 hours''', 'interval ''10 minutes''');
  END LOOP;
END
$patch$;
