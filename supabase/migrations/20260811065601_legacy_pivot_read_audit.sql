-- Step C, part 1 (observation instrumentation only): confirm -- don't
-- assume -- that nothing still reads ledger_balance_pivot or
-- wallets_physical.withdrawable_balance/float_balance before dropping
-- trg_ledger_pivot_apply or the agent-withdrawal pivot guard.
--
-- Static analysis (src/**, supabase/functions/**) found only a docs
-- generator (send-system-context/doc.ts) touching wallets_physical's
-- legacy columns, and nothing at all reading ledger_balance_pivot's data
-- (two frontend hooks subscribe to wallets_physical's *change stream* for
-- cache invalidation only -- confirmed by reading the code, they never
-- select withdrawable_balance/float_balance). That's not sufficient proof
-- on its own: it can't see ad-hoc SQL run by a human via the Supabase SQL
-- editor, or a BI/reporting tool connected directly to Postgres outside
-- this codebase.
--
-- This migration adds passive, non-behavior-changing audit logging to
-- both tables' existing SELECT policies (each rewritten to call a logging
-- wrapper that reproduces the EXACT same access decision, then logs iff
-- access was actually granted) so any authenticated-role read shows up in
-- legacy_pivot_read_audit over the observation window.
--
-- KNOWN LIMITATION: service_role bypasses RLS entirely, so this does NOT
-- catch reads from edge functions or scheduled jobs using the service
-- role key. Static analysis already covers that surface for tracked code
-- (supabase/functions/**); for anything run directly against Postgres
-- outside this codebase, check Supabase's own Logs Explorer for queries
-- referencing these tables/columns over the same window -- this migration
-- is a complement to that, not a replacement for it.
--
-- Nothing here changes who can read what. Both policies are rewritten to
-- return the identical boolean their current USING clause already
-- returns; the wrapper only adds a logging side effect when that boolean
-- is true. Safe to drop after the observation window (see the DOWN notes
-- at the bottom) regardless of what Step C's later items decide.

CREATE TABLE IF NOT EXISTS public.legacy_pivot_read_audit (
  id bigserial PRIMARY KEY,
  observed_at timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL,
  row_user_id uuid,
  role_name text,
  actor_uid uuid
);

CREATE INDEX IF NOT EXISTS idx_legacy_pivot_read_audit_observed
  ON public.legacy_pivot_read_audit (observed_at DESC);

-- Diagnostic table only, no client access -- read via service_role /
-- Supabase Studio during the observation window.
ALTER TABLE public.legacy_pivot_read_audit ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.legacy_pivot_read_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.legacy_pivot_read_audit_id_seq TO service_role;

-- =========================================================================
-- 1. ledger_balance_pivot: reproduce "Pivot readable by owner" exactly,
--    logging only when it actually grants access.
-- =========================================================================
CREATE OR REPLACE FUNCTION public._log_and_check_pivot_read(p_row_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := (auth.uid() = p_row_user_id)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role);

  IF v_allowed THEN
    BEGIN
      INSERT INTO public.legacy_pivot_read_audit (table_name, row_user_id, role_name, actor_uid)
      VALUES ('ledger_balance_pivot', p_row_user_id, current_setting('role', true), auth.uid());
    EXCEPTION WHEN OTHERS THEN
      NULL; -- never let logging break a legitimate read
    END;
  END IF;

  RETURN v_allowed;
END;
$$;

REVOKE ALL ON FUNCTION public._log_and_check_pivot_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._log_and_check_pivot_read(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Pivot readable by owner" ON public.ledger_balance_pivot;
CREATE POLICY "Pivot readable by owner"
  ON public.ledger_balance_pivot FOR SELECT
  USING (public._log_and_check_pivot_read(user_id));

-- =========================================================================
-- 2. wallets_physical: reproduce "Users can view own wallet" exactly
--    (the only SELECT policy this table has ever had, per migration
--    history -- carried over unchanged from the original `wallets` table
--    through its later rename to wallets_physical), logging only when it
--    actually grants access. Table-level, not column-level -- Postgres
--    RLS can't distinguish which columns a query selects, so this logs
--    any direct read of the row, which is itself the useful signal: the
--    sanctioned path is the `wallets` view / get_user_wallet_view, so any
--    direct wallets_physical read bypassing that is worth knowing about
--    regardless of which columns it pulls.
-- =========================================================================
CREATE OR REPLACE FUNCTION public._log_and_check_wallets_physical_read(p_row_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := (auth.uid() = p_row_user_id);

  IF v_allowed THEN
    BEGIN
      INSERT INTO public.legacy_pivot_read_audit (table_name, row_user_id, role_name, actor_uid)
      VALUES ('wallets_physical', p_row_user_id, current_setting('role', true), auth.uid());
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN v_allowed;
END;
$$;

REVOKE ALL ON FUNCTION public._log_and_check_wallets_physical_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._log_and_check_wallets_physical_read(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets_physical;
CREATE POLICY "Users can view own wallet"
  ON public.wallets_physical FOR SELECT
  USING (public._log_and_check_wallets_physical_read(user_id));

-- =========================================================================
-- To remove this instrumentation once the observation window is done
-- (independent of whatever Step C's later items decide):
--
--   DROP POLICY "Pivot readable by owner" ON public.ledger_balance_pivot;
--   CREATE POLICY "Pivot readable by owner" ON public.ledger_balance_pivot
--     FOR SELECT USING (
--       auth.uid() = user_id OR public.has_role(auth.uid(),'manager'::app_role)
--       OR public.has_role(auth.uid(),'cfo'::app_role) OR public.has_role(auth.uid(),'cto'::app_role)
--     );
--   DROP POLICY "Users can view own wallet" ON public.wallets_physical;
--   CREATE POLICY "Users can view own wallet" ON public.wallets_physical
--     FOR SELECT USING (auth.uid() = user_id);
--   DROP FUNCTION public._log_and_check_pivot_read(uuid);
--   DROP FUNCTION public._log_and_check_wallets_physical_read(uuid);
--   -- legacy_pivot_read_audit itself can stay as a historical record, or
--   -- be dropped too once reviewed.
-- =========================================================================
