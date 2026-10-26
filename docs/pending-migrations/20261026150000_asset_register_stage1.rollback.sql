-- DEVELOPMENT ONLY: rollback for docs/pending-migrations/20261026150000_asset_register_stage1.sql.
-- Removes the Stage 1 asset register objects. Touches no ledger, wallet or payment object.
-- WARNING: dropping the tables discards every registered asset and its audit trail. Export first.
-- The `asset-evidence` bucket is only removed when it is empty (storage objects are never deleted here).
BEGIN;

DROP POLICY IF EXISTS asset_evidence_read ON storage.objects;
DROP POLICY IF EXISTS asset_evidence_insert ON storage.objects;
DELETE FROM storage.buckets b
 WHERE b.id = 'asset-evidence'
   AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'asset-evidence');

DROP FUNCTION IF EXISTS public.asset_register_add_evidence(uuid, text, text);
DROP FUNCTION IF EXISTS public.asset_register_import_commit(text, text, jsonb);
DROP FUNCTION IF EXISTS public.asset_register_check_duplicates(jsonb);
DROP FUNCTION IF EXISTS public.asset_register_reference_data();
DROP FUNCTION IF EXISTS public.asset_register_summary();
DROP FUNCTION IF EXISTS public.asset_register_get(uuid);
DROP FUNCTION IF EXISTS public.asset_register_list(text, text, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.asset_register_update(uuid, timestamptz, jsonb, text);
DROP FUNCTION IF EXISTS public.asset_register_create(jsonb);
DROP FUNCTION IF EXISTS public._asset_register_serial_owner(text, text, uuid);
DROP FUNCTION IF EXISTS public._asset_register_insert(jsonb, uuid, uuid, text);
DROP FUNCTION IF EXISTS public._asset_register_row_json(public.assets);
DROP FUNCTION IF EXISTS public._asset_register_validate(jsonb, boolean);

-- Triggers block DELETE row-by-row; DROP TABLE is DDL and is not affected.
DROP TABLE IF EXISTS public.asset_events;
DROP TABLE IF EXISTS public.assets;
DROP TABLE IF EXISTS public.asset_import_batches;

DROP FUNCTION IF EXISTS public._asset_register_require(boolean);
DROP FUNCTION IF EXISTS public.asset_register_write_ok();
DROP FUNCTION IF EXISTS public.asset_register_read_ok();
DROP FUNCTION IF EXISTS public._asset_register_guard_identity();
DROP FUNCTION IF EXISTS public._asset_register_block_mutation();
DROP SEQUENCE IF EXISTS public.asset_code_seq;

COMMIT;
