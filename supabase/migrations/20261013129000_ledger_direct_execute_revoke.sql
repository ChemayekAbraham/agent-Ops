-- Ledger posting boundary, part 2 of 2: no signed-in user may call
-- create_ledger_transaction* directly.
--
-- NOT APPLIED TO PRODUCTION. Apply ONLY after:
--   1. 20261013126000 (post_portfolio_roi_ledger) is applied, AND
--   2. the frontend whose COOPartnersPage calls post_portfolio_roi_ledger() is
--      published and its Returns compounding / split payout verified.
-- Applied earlier, the live COO Partners page (which still calls
-- create_ledger_transaction with the user's session) stops posting Returns.
--
-- WHAT. EXECUTE on every create_ledger_transaction* overload is revoked from
-- PUBLIC, anon and authenticated and granted to service_role explicitly. No
-- function DEFINITION is changed. Edge functions use the service role, and
-- SQL functions that post run as their owner, so neither is affected
-- provided each definer caller's owner keeps EXECUTE other than through
-- PUBLIC (production evidence pack E6b).
--
-- ROLLBACK: GRANT EXECUTE on the overloads back to authenticated only if the
-- old exposure is wanted back (it should not be).

-- ═══════════════ close the direct path ═══════════════
-- Every overload, whatever its signature (the legacy 4-argument one is
-- reported to exist live). Fails closed if the canonical function is missing.
DO $rev$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND p.proname LIKE 'create\_ledger\_transaction%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    n := n + 1;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'create_ledger_transaction') THEN
    RAISE EXCEPTION 'create_ledger_transaction not found; refusing to continue';
  END IF;
  RAISE NOTICE 'ledger boundary: EXECUTE revoked from PUBLIC/anon/authenticated on % overload(s)', n;
END
$rev$;
