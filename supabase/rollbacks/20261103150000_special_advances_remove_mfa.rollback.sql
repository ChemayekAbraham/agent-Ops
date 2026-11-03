-- Rollback of 20261103150000_special_advances_remove_mfa. Needs explicit CFO approval.
-- Restores the Special Advances authenticator requirement exactly as Phase 4 (20261028153000) defined it: the
-- _special_advance_require_mfa() body, _special_advance_guard_mfa() and the trigger special_advances_require_mfa.
-- Nothing else changes. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_require_mfa()'))
       IS DISTINCT FROM 'befb1ed9f392247206adc532fec7ba2e'
     OR to_regprocedure('public._special_advance_guard_mfa()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'special_advances_require_mfa') THEN
    RAISE EXCEPTION 'precondition failed: 20261103150000 is not the current state; nothing was changed';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public._special_advance_require_mfa()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND COALESCE(auth.jwt() ->> 'aal', 'aal1') IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE = '42501',
      DETAIL = 'Approving, paying out or recording a repayment needs a session verified with your authenticator app';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._special_advance_guard_mfa()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved', 'disbursed') THEN
    PERFORM public._special_advance_require_mfa();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER special_advances_require_mfa BEFORE UPDATE ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_mfa();
REVOKE ALL ON FUNCTION public._special_advance_guard_mfa() FROM PUBLIC, anon, authenticated;

DO $post$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._special_advance_require_mfa()'::regprocedure)
       IS DISTINCT FROM '3e17151264fa6029141eb4c2ccc39b96'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._special_advance_guard_mfa()'::regprocedure)
       IS DISTINCT FROM '64757ef8049d1e2f9f54c7af7e172ecb'
     OR has_function_privilege('authenticated', 'public._special_advance_require_mfa()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._special_advance_guard_mfa()', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondition failed: the Phase 4 authenticator check was not restored exactly; nothing was changed';
  END IF;
END
$post$;

RESET lock_timeout;
