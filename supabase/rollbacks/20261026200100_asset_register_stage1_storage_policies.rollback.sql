-- Rollback for 20261026200100_asset_register_stage1_storage_policies.sql: removes the two asset evidence policies (evidence
-- then becomes unreachable from the client; stored objects are kept). Must run as the owner of storage.objects, like the
-- migration. Run as one transaction.
-- Production names (created in the Supabase dashboard on 2026-10-26, which appended a suffix):
--   "asset_evidence_read 1iodt3o_0" (SELECT) and "asset_evidence_insert 1iodt3o_0" (INSERT).
-- The unsuffixed names are dropped too, in case a database was built from this file directly. Afterwards no
-- storage.objects policy may still reach the bucket or call the register gates, otherwise the whole rollback is undone.
DO $pre$
BEGIN
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'storage.objects'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'precondition failed: % does not own storage.objects; nothing was changed', current_user;
  END IF;
END
$pre$;

DROP POLICY IF EXISTS "asset_evidence_read 1iodt3o_0" ON storage.objects;
DROP POLICY IF EXISTS "asset_evidence_insert 1iodt3o_0" ON storage.objects;
DROP POLICY IF EXISTS asset_evidence_read ON storage.objects;
DROP POLICY IF EXISTS asset_evidence_insert ON storage.objects;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(asset-evidence|asset_register_(read|write)_ok)') THEN
    RAISE EXCEPTION 'rollback check failed: a storage.objects policy still reaches asset-evidence (renamed?); rolled back, nothing changed';
  END IF;
END
$post$;
