-- Rollback for 20261026200000_asset_register_stage1.sql: removes the Stage 1 asset register objects. Touches no ledger, wallet or payment object.
-- Refuses, changing nothing, unless the storage policies were rolled back first, and refuses while the register holds
-- any asset unless the caller deliberately sets  SET LOCAL asset_register.rollback_discard_data = 'yes';  (dropping the
-- tables discards every registered asset and its audit trail: export first).
-- The `asset-evidence` bucket is only removed when it is empty (storage objects are never deleted here).
-- Run as one transaction.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.assets') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 20261026200000_asset_register_stage1 is not applied; nothing was changed';
  END IF;
  IF to_regclass('public.asset_sites') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: roll back 20261027150000_asset_register_asset_tags first; nothing was changed';
  END IF;
  -- Name-agnostic: any storage.objects policy that reaches the bucket or calls the register gates blocks the rollback
  -- (in production the dashboard named them "asset_evidence_read 1iodt3o_0" / "asset_evidence_insert 1iodt3o_0").
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(asset-evidence|asset_register_(read|write)_ok)') THEN
    RAISE EXCEPTION 'precondition failed: roll back 20261026200100_asset_register_stage1_storage_policies first; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.assets) AND coalesce(current_setting('asset_register.rollback_discard_data', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'precondition failed: the register holds assets; export them, then set asset_register.rollback_discard_data = yes to discard; nothing was changed';
  END IF;
END
$pre$;

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

RESET lock_timeout;
