-- 2026-10-26: CFO Asset Tracking Register, Stage 1 (storage policies for the private `asset-evidence` bucket). NOT APPLIED.
-- Only the owner of storage.objects (supabase_storage_admin, or a role that is a member of it, e.g. the role Lovable's
-- migration tool and the Supabase dashboard use) may create these policies. The CLI's postgres login is NOT a member,
-- so applying this file with `supabase db query` as postgres is refused by the preflight below, changing nothing.
-- Requires 20261026200000_asset_register_stage1 to be applied first (the policies call asset_register_read_ok / asset_register_write_ok).
-- Read: register readers only. Upload: register writers only, under assets/<asset id>/<uuid>.<ext>.
-- No UPDATE or DELETE policy: evidence is never replaced or removed from the client.
-- TRANSACTION: run as ONE transaction. Rollback: supabase/rollbacks/20261026200100_asset_register_stage1_storage_policies.rollback.sql

DO $pre$
BEGIN
  IF to_regprocedure('public.asset_register_read_ok()') IS NULL
     OR to_regprocedure('public.asset_register_write_ok()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'asset-evidence' AND public = false) THEN
    RAISE EXCEPTION 'precondition failed: apply 20261026200000_asset_register_stage1 first; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname IN ('asset_evidence_read', 'asset_evidence_insert')) THEN
    RAISE EXCEPTION 'precondition failed: the asset evidence policies already exist; nothing was changed';
  END IF;
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'storage.objects'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'precondition failed: % does not own storage.objects; apply through an owner-level route (see header); nothing was changed', current_user;
  END IF;
END
$pre$;

-- Read: register readers only. Upload: register writers only, under assets/<asset id>/.
-- No UPDATE or DELETE policy: evidence is never replaced or removed from the client.
CREATE POLICY asset_evidence_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'asset-evidence'
         AND (select public.asset_register_read_ok())
         AND (select public.staff_mfa_ok()));
CREATE POLICY asset_evidence_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'asset-evidence'
              AND name ~ '^assets/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$'
              AND (select public.asset_register_write_ok())
              AND (select public.staff_mfa_ok()));
