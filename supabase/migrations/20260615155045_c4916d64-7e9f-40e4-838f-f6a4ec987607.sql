-- Revert the bulk auto-verification of LC1 chairpersons so that each one
-- must be verified manually by Landlord Ops (manager) via the Hold-to-Verify control.
-- Only undo rows that were part of the system backfill (no human verifier recorded).
UPDATE public.lc1_chairpersons
SET verified = false,
    verified_at = NULL,
    verified_by = NULL
WHERE verified = true
  AND verified_by IS NULL;