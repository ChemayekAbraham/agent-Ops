-- Blocker 2: retire the ambiguous 4-argument apply_advance_topup overload.
--
-- THE DEFECT
-- ----------
-- Two overloads existed:
--   apply_advance_topup(uuid, numeric, integer, uuid)
--   apply_advance_topup(uuid, numeric, integer, uuid, text DEFAULT NULL,
--                       boolean DEFAULT false)
-- Because the 6-argument version defaults its last two parameters, BOTH match a
-- 4-argument named call. Verified by parse-only EXPLAIN:
--   ERROR 42725: function public.apply_advance_topup(p_advance_id => uuid,
--   p_amount => numeric, p_extend_days => integer, p_request_id => uuid)
--   is not unique
--
-- The 4-argument version also posts NO ledger entry at all, so it is a second,
-- silent origination path for new advance principal.
--
-- IT HAS NEVER RUN. Only one top-up request has ever existed (2026-08-30,
-- principal 18,000, status `rejected`), so the request-merge caller never
-- completed. The seven historical top-ups that carry no GL all have
-- `extend_days IS NULL`, which neither overload can produce -- they predate
-- both. Dropping this function therefore removes no working behaviour.
--
-- ANONYMOUS EXECUTION
-- -------------------
-- Both overloads hold EXECUTE for `anon`, and their internal role gate ends
-- with `OR auth.uid() IS NULL` -- so a caller with no identity SATISFIES the
-- check by having none. The 6-argument version keeps that clause (rewriting a
-- money function's body is a larger edit than this change warrants, and it is
-- due to be rewritten anyway for the A11 fee legs), but the grant is revoked,
-- which is the effective control and matches how the three recovery RPCs were
-- closed on 2026-09-26.
--
-- `authenticated` KEEPS EXECUTE on the 6-argument version: it is called from
-- the browser by src/components/cfo/CFOAdvanceTopupDialog.tsx. No edge
-- function, database function or cron job calls either overload, so no
-- service-role path is affected.
--
-- NOT CHANGED: no wallet movement, no ledger entry, no balance, no top-up
-- arithmetic. The surviving function's body is untouched.

---------------------------------------------------------------------------
-- 1. Drop the ambiguous, GL-less overload.
---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.apply_advance_topup(uuid, numeric, integer, uuid);

---------------------------------------------------------------------------
-- 2. Close anonymous execution on the surviving path.
--    service_role and postgres are deliberately untouched.
---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.apply_advance_topup(uuid, numeric, integer, uuid, text, boolean)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.apply_advance_topup(uuid, numeric, integer, uuid, text, boolean)
  TO authenticated;

COMMENT ON FUNCTION public.apply_advance_topup(uuid, numeric, integer, uuid, text, boolean) IS
  'Sole agent-advance top-up path as of 2026-09-26. The 4-argument overload was '
  'dropped: it was ambiguous with this signature (SQLSTATE 42725) and posted no '
  'ledger entry. Callable by authenticated staff holding cfo/manager/agent_ops/'
  'coo/super_admin, and by service_role. Not callable by anon. Do not reintroduce '
  'a shorter overload.';
