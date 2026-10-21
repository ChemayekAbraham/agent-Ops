-- Harden the verified-email bonus against double-crediting.
--
-- What was already safe
-- ---------------------
-- create_ledger_transaction() takes pg_advisory_xact_lock(hashtext(key)) and
-- then returns the EXISTING transaction_group_id when a leg with that key is
-- already present. With the key 'email_verification_bonus:<user_id>' the money
-- therefore cannot post twice, no matter how the callers race. Note that it
-- RETURNS rather than raising, so the `EXCEPTION WHEN unique_violation` arm
-- wrapped around that call is dead code (the same defensive habit appears in
-- 20260925110000_contact_location_capture_bonus.sql). It is left in place as a
-- harmless backstop but it is not what protects us.
--
-- What was not tight
-- ------------------
-- The lock lives inside create_ledger_transaction, so it is taken AFTER this
-- function has already decided the user is eligible. Two challenges for one
-- user, confirmed concurrently, could both pass the `EXISTS (... WHERE
-- bonus_credited_at IS NOT NULL)` check, because under READ COMMITTED neither
-- transaction can see the other's uncommitted row. Both would then reach the
-- ledger, where only one posts and the loser falls through to
-- uq_evc_one_bonus_per_user and reports 'already_credited'. The outcome was
-- correct, but only because of a constraint two layers down.
--
-- Taking the same lock here makes the EXISTS check authoritative: one
-- transaction at a time evaluates eligibility for a given user, and the loser
-- sees the winner's committed bonus_credited_at and skips cleanly. Same lock
-- key as create_ledger_transaction uses, so the two never deadlock against
-- each other — the inner acquisition is simply already held.
DO $patch$
DECLARE
  v_def text;
  v_anchor text := '  v_dom := split_part(v_ch.old_email, ''@'', 2);';
  v_lock text :=
    '  -- Serialise eligibility AND credit per user, not just the ledger write.' || E'\n' ||
    '  -- Same key create_ledger_transaction locks on, so the inner acquisition' || E'\n' ||
    '  -- below is a no-op re-entry rather than a second lock.' || E'\n' ||
    '  PERFORM pg_advisory_xact_lock(hashtext(''email_verification_bonus:'' || v_ch.user_id::text));' || E'\n\n';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'confirm_email_verification';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'confirm_email_verification not found';
  END IF;

  IF position('pg_advisory_xact_lock' IN v_def) > 0 THEN
    RAISE NOTICE 'Per-user lock already present; leaving as is.';
    RETURN;
  END IF;

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Anchor not found in confirm_email_verification — refusing to patch blind.';
  END IF;

  v_def := replace(v_def, v_anchor, v_lock || v_anchor);
  EXECUTE v_def;
  RAISE NOTICE 'Per-user serialisation added to confirm_email_verification.';
END
$patch$;
