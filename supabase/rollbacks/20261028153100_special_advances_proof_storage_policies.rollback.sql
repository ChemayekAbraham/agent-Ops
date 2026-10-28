-- Rollback of 20261028153100_special_advances_proof_storage_policies. Needs explicit CFO approval.
-- Removes the two storage.objects policies of the special-advance-proofs bucket. The bucket and every proof file stay
-- (they are records). Needs the same owner-level route as the forward migration.
-- TRANSACTION: run as ONE transaction.
DO $pre$
BEGIN
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'storage.objects'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'precondition failed: % does not own storage.objects; apply through an owner-level route; nothing was changed', current_user;
  END IF;
END
$pre$;

DROP POLICY IF EXISTS special_advance_proofs_read ON storage.objects;
DROP POLICY IF EXISTS special_advance_proofs_insert ON storage.objects;
