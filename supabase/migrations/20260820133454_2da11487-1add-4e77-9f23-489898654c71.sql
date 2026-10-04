DO $do$
DECLARE
  r record;
  v_def text;
BEGIN
  FOR r IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('ops_link_user_to_agent','ops_update_user_identity','ops_update_landlord')
      AND pg_get_functiondef(p.oid) ~* 'audit_logs[^;]*performed_by'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_def := replace(v_def, 'record_id, performed_by, reason, metadata', 'record_id, user_id, reason, metadata');
    v_def := replace(v_def, 'record_id, reason, performed_by, metadata', 'record_id, reason, user_id, metadata');
    EXECUTE v_def;
  END LOOP;
END
$do$;