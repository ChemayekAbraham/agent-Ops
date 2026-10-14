-- 2026-10-13 (doc 221): suppressed e-mails are not delivery failures.
-- 'suppressed' = the address is on the suppression list, so we deliberately did not
-- send. get_cto_issue_intelligence counted it in "Outbound notification delivery
-- failures" (37 on 10-12, all suppressed, zero failed/bounced/dlq). It now excludes
-- 'suppressed' from the failure counts and exposes suppressed_today/_7d/_30d, which
-- daily-cto-report renders as its own "Emails suppressed today" tile.
DO $patch$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname='get_cto_issue_intelligence' AND p.pronamespace='public'::regnamespace;
  v_new := replace(v_def, 'status NOT IN (''sent'',''pending'')', 'status NOT IN (''sent'',''pending'',''suppressed'')');
  v_new := replace(v_new,
    '''sent_today'', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end),',
    '''sent_today'', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end),
    ''suppressed_today'', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end AND status = ''suppressed''),
    ''suppressed_7d'', count(*) FILTER (WHERE created_at >= v_7d AND status = ''suppressed''),
    ''suppressed_30d'', count(*) FILTER (WHERE created_at >= v_30d AND status = ''suppressed''),');
  IF v_new = v_def OR position('suppressed_today' in v_new) = 0 OR position('''sent'',''pending'',''suppressed''' in v_new) = 0 THEN RAISE EXCEPTION 'anchors missing'; END IF;
  EXECUTE v_new;
END $patch$;
