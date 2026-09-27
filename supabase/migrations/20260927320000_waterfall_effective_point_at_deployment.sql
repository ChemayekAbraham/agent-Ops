-- Agent Advance waterfall: set the effective point to the deployment moment.
--
-- NOT YET APPLIED.
--
-- WHY
-- ---
-- `treasury_controls.agent_advance_waterfall_from` was seeded by
-- 20260927220000 as 2026-09-27 14:37:17.448571+00. That instant is already in
-- the past, so between it and the moment the package actually deploys there is
-- an open window: an advance issued in that window would be POST-effective
-- (the waterfall applies to it) while having been ORIGINATED by the old code,
-- which does not create the A10 principal or A20 registration-fee components
-- that 20260927300000 adds. Such an advance could never reconcile
-- `outstanding_balance` to its ledger-derived components, and no historical
-- restatement is permitted to repair it.
--
-- 20260927220000 inserts the control row with ON CONFLICT DO NOTHING, so
-- re-running it does NOT move the timestamp. It is also already applied in
-- production, so a migration runner would not re-execute it at all. Amending
-- an already-applied migration would therefore have no effect at deploy time,
-- and would break the audit trail of what was actually applied. Hence this
-- separate, additive migration.
--
-- ORDERING
-- --------
-- This file is deliberately LAST in the package (timestamp 320000, after the
-- origination and top-up corrections at 300000 / 310000). By the time it runs,
-- every other migration is live -- including the corrected origination. `now()`
-- is therefore the first instant at which a correctly-componentised advance can
-- exist, and every advance originated before it -- including any created during
-- the migration run itself -- becomes retroactively PRE-effective and stays on
-- the old treatment. That closes the window completely and removes any
-- deploy-time timing race.
--
-- SELF-GUARD
-- ----------
-- The NOT EXISTS clause makes this safe to execute again. Once any advance is
-- genuinely post-effective, moving the boundary would strand waterfall legs
-- that have already been posted against it, so the statement must become a
-- no-op. Both branches were verified in the disposable sandbox and rolled back:
--
--   Case A  8 post-effective advances present
--           -> value unchanged (2026-09-01 -> 2026-09-01), guard blocked it
--   Case B  0 post-effective advances (boundary pushed to 2099 first)
--           -> value set to now(); every advance became pre-effective; the
--              post-effective count went to 0
--
-- If the control row is absent the UPDATE simply affects no rows. If `value`
-- is NULL or empty, NULLIF(...)::timestamptz yields NULL, the comparison is
-- NULL for every row, NOT EXISTS is true, and the boundary is set -- which is
-- the correct behaviour for an unset control.
--
-- SCOPE
-- -----
-- This migration touches one column of one row of one control table. It makes
-- no change to wallet, repayment, ledger, operational or accounting logic.
-- Verified by call graph against production:
--
--   agent_advance_waterfall_from()   <- read only by agent_advance_is_post_effective()
--   agent_advance_is_post_effective  <- read only by agent_advance_allocation_entries()
--   agent_advance_allocation_entries <- called only by the six wired repayment
--                                       paths, all with p_external => false
--   other readers of the control row: NONE
--
-- Nothing else in the database reads this value, so the only thing it can
-- change is where the pre-effective / post-effective boundary falls.

UPDATE public.treasury_controls tc
SET value = now()::text,
    enabled = true,
    updated_at = now()
WHERE tc.control_key = 'agent_advance_waterfall_from'
  AND NOT EXISTS (
    SELECT 1
    FROM public.agent_advances a
    WHERE a.issued_at >= NULLIF(tc.value, '')::timestamptz
  );
