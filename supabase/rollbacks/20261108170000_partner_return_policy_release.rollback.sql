-- Rollback for 20261108170000_partner_return_policy_release.sql: release_ready back to false.
-- Only while the switch is off; once the CEO has turned it on, turn it off first (set_partner_return_policy).
SET client_encoding = 'UTF8';
DO $$
BEGIN
  IF (SELECT enabled FROM public.partner_return_policy WHERE id) THEN
    RAISE EXCEPTION 'Turn the Partner Returns switch off before undoing the release' USING ERRCODE = '55000';
  END IF;
  UPDATE public.partner_return_policy SET release_ready = false, note = 'Phase 7 release rolled back' WHERE id;
END $$;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108170000';
