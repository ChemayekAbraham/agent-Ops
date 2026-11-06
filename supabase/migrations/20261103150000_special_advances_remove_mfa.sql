-- 2026-11-03: Special Advances, authenticator requirement removed. Production apply needs explicit CFO approval.
-- CFO decision 2026-11-03: the authenticator app (MFA / TOTP, a session at aal2) is no longer required anywhere in the
-- Special Advances workflow. An enabled CFO completes approval, payout, repayment, correction, provision review,
-- write-off and recovery with a normal signed-in session. This replaces D5 (2026-10-27) and D14 (2026-11-02).
--
-- Change (no table, ledger, mapping, account, balance or posting changes):
--   * trigger special_advances_require_mfa (approval and payout transitions) and its function
--     _special_advance_guard_mfa() are dropped;
--   * _special_advance_require_mfa() no longer refuses anything. Its seven callers (the guard above,
--     special_advance_disburse, special_advance_record_repayment, special_advance_record_correction,
--     special_advance_post_provision_review, special_advance_write_off, special_advance_record_recovery) are applied in
--     production and are not rewritten; they keep calling this one function, so the requirement can be restored in one
--     place (the rollback does exactly that).
-- Unchanged: every function still checks the enabled CFO role itself (_special_advance_require_cfo), the issuance switch,
-- the self-advance rule, reasons, proof files (private bucket, used once), idempotency, locking, append-only records and
-- audit events. The project-wide staff MFA layer (staff_mfa_config, staff_mfa_ok() on every table, require_staff_aal2 in
-- other modules) is a separate Welile-wide control and is NOT changed here.
-- Preflight refuses (nothing changed) unless both functions are exactly the production definitions (read-only check
-- 2026-11-03) and the trigger exists. Rollback: supabase/rollbacks/20261103150000_special_advances_remove_mfa.rollback.sql
-- Tests: src/test/specialAdvanceNoMfa.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_require_mfa()'))
       IS DISTINCT FROM '3e17151264fa6029141eb4c2ccc39b96'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_guard_mfa()'))
       IS DISTINCT FROM '64757ef8049d1e2f9f54c7af7e172ecb'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.special_advances'::regclass
                     AND tgname = 'special_advances_require_mfa' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'precondition failed: the Special Advances authenticator check is not the production definition (Phase 4); nothing was changed';
  END IF;
END
$pre$;

DROP TRIGGER special_advances_require_mfa ON public.special_advances;
DROP FUNCTION public._special_advance_guard_mfa();

CREATE OR REPLACE FUNCTION public._special_advance_require_mfa()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
  -- CFO decision 2026-11-03: Special Advances need no authenticator-verified session (aal2). The enabled CFO role is
  -- checked by every caller. Kept as the single place to restore the requirement (see the rollback).
  RETURN;
END $$;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'special_advances_require_mfa')
     OR to_regprocedure('public._special_advance_guard_mfa()') IS NOT NULL
     OR has_function_privilege('authenticated', 'public._special_advance_require_mfa()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._special_advance_require_mfa()', 'EXECUTE')
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public._special_advance_require_mfa()'::regprocedure)
          IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'postcondition failed: the authenticator check was not removed cleanly; nothing was changed';
  END IF;
END
$post$;

RESET lock_timeout;
