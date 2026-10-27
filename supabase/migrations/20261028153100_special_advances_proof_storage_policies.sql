-- 2026-10-27: Special Advances, Phase 4 (storage policies for the private `special-advance-proofs` bucket). NOT APPLIED.
-- CFO decision D1/D2 (2026-10-27): an external payout and every repayment need an archived proof file; see
-- docs/special-advances/phase4-cfo-decisions.md. Requires 20261028153000_special_advances_payout_repayment first (it
-- creates the bucket and the proof checks).
-- Only the owner of storage.objects (supabase_storage_admin, or a role that is a member of it, e.g. the role the
-- Supabase dashboard and Lovable's migration tool use) may create these policies. The CLI's postgres login is NOT a
-- member, so applying this file with `supabase db query` as postgres is refused by the preflight below, changing
-- nothing. Same route as 20261026200100_asset_register_stage1_storage_policies.
-- Read: an enabled CFO (with staff MFA where required). Upload: the same, under advances/<advance id>/<uuid>.<ext>.
-- No UPDATE or DELETE policy: a proof is never replaced or removed from the client.
-- TRANSACTION: run as ONE transaction. Rollback: supabase/rollbacks/20261028153100_special_advances_proof_storage_policies.rollback.sql

DO $pre$
BEGIN
  IF to_regprocedure('public.special_advance_cfo_ok()') IS NULL
     OR to_regprocedure('public._special_advance_check_proof(uuid,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'special-advance-proofs' AND public = false) THEN
    RAISE EXCEPTION 'precondition failed: apply 20261028153000_special_advances_payout_repayment first; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'special-advance-proofs') THEN
    RAISE EXCEPTION 'precondition failed: the Special Advances proof policies already exist; nothing was changed';
  END IF;
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'storage.objects'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'precondition failed: % does not own storage.objects; apply through an owner-level route (see header); nothing was changed', current_user;
  END IF;
END
$pre$;

CREATE POLICY special_advance_proofs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'special-advance-proofs'
         AND (select public.special_advance_cfo_ok()) AND (select public.staff_mfa_ok()));

CREATE POLICY special_advance_proofs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'special-advance-proofs'
              AND name ~ '^advances/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$'
              AND (select public.special_advance_cfo_ok()) AND (select public.staff_mfa_ok()));
