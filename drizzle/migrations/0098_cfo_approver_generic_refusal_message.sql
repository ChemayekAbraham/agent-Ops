-- Replace the disclosing CFO-approver refusal text with a generic failure message.
-- Bodies are regenerated from pg_get_functiondef with only the message literal swapped,
-- so signatures, defaults, ownership and grants are preserved. No logic changes.
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
      AND pg_get_functiondef(p.oid) LIKE '%Only the designated CFO approver may action CFO Dashboard requests%'
  LOOP
    v_def := replace(
      pg_get_functiondef(r.oid),
      'Only the designated CFO approver may action CFO Dashboard requests',
      'This request could not be completed'
    );
    EXECUTE v_def;
  END LOOP;
END
$do$;
