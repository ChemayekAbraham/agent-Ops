-- Control hardening for agent_advances. No accounting change.
--
-- WHY
-- ---
-- Two direct-write paths bypass every RPC, audit trail and GL posting:
--
-- 1. `create_overdraft_recovery_advance` is SECURITY DEFINER with NO auth or
--    role check of any kind — its only guard is `IF v_principal < 100 THEN
--    RETURN NULL`. It is granted EXECUTE to PUBLIC, anon and authenticated, so
--    any authenticated user can mint an agent advance against ANY p_user_id,
--    with a 33% access fee, no audit row and no ledger entry. It is called
--    legitimately by supabase/functions/approve-withdrawal (service_role), and
--    has never executed successfully in production — zero
--    `overdraft_recovery_advance_opened` audit rows.
--
-- 2. `agent_advances` grants INSERT/UPDATE/DELETE/TRUNCATE to BOTH
--    `authenticated` and `anon`, on all 42 of 42 columns. The only protection
--    is RLS policy "Managers can update advances", whose USING clause is
--    purely role-based with WITH CHECK omitted — so any of the 31 users
--    holding `manager` can set outstanding_balance, principal, access_fee,
--    status or gate_override to any value over PostgREST, with no RPC, no
--    audit row and no GL entry. A matching DELETE policy exists and has been
--    used once (2026-05-05, one advance destroyed outright).
--
-- WHAT THIS DOES
-- --------------
-- Makes the table client read-only. Every write continues through the RPCs and
-- edge functions, which run as service_role and are unaffected.
--
-- Verified before writing this: `src/` contains 27 references to
-- `agent_advances` — zero .update(), zero .insert(), and ONE .delete()
-- (CFOAdvancesManager.tsx), which is replaced in the same change by the
-- existing cancel_agent_advance RPC. Nothing else client-side depends on
-- these privileges.
--
-- OUT OF SCOPE — deliberately unchanged
-- -------------------------------------
-- No GL treatment, no ledger_account_map change, no resolver change, no wallet
-- or tenant-repayment behaviour, no advance balance touched, and no change to
-- create_overdraft_recovery_advance's own logic (its missing role check and
-- missing GL posting are tracked separately).

---------------------------------------------------------------------------
-- 1. Close the advance-minting exposure.
--    service_role keeps EXECUTE, so approve-withdrawal is unaffected.
---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.create_overdraft_recovery_advance(uuid, numeric, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

---------------------------------------------------------------------------
-- 2. Make agent_advances client read-only.
---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.agent_advances FROM authenticated;
REVOKE ALL                              ON public.agent_advances FROM anon;

-- SELECT is deliberately retained for `authenticated`; the existing RLS
-- SELECT policies continue to scope which rows each role may read.
GRANT SELECT ON public.agent_advances TO authenticated;

COMMENT ON TABLE public.agent_advances IS
  'Agent cash advances. CLIENT READ-ONLY as of 2026-09-25: authenticated holds '
  'SELECT only, anon holds nothing. Every INSERT/UPDATE/DELETE must go through a '
  'SECURITY DEFINER RPC or a service_role edge function so the change carries an '
  'audit row and (once the GL phase lands) a balanced ledger entry. Do not '
  'restore blanket DML grants.';
