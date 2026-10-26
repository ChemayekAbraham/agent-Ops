-- Rollback for 20261026200100_asset_register_stage1_storage_policies.sql: removes the two asset evidence policies (evidence then becomes unreachable from the
-- client; stored objects are kept). Must run as the owner of storage.objects, like the migration. Run as one transaction.
DO $pre$
BEGIN
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'storage.objects'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'precondition failed: % does not own storage.objects; nothing was changed', current_user;
  END IF;
END
$pre$;

DROP POLICY IF EXISTS asset_evidence_read ON storage.objects;
DROP POLICY IF EXISTS asset_evidence_insert ON storage.objects;
