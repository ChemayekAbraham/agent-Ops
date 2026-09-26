-- Security hardening for the three agent-advance recovery RPCs.
-- No accounting change, no balance change, no logic change.
--
-- WHY
-- ---
-- All three are SECURITY DEFINER owned by `postgres`, contain no auth.uid()
-- and no has_role() check, and held EXECUTE for `anon` (and, for
-- apply_roi_advance_recovery, for PUBLIC). They are therefore callable
-- unauthenticated over PostgREST with the public anon key, and each one
-- writes agent_advances, agent_advance_ledger and the general ledger via
-- create_ledger_transaction.
--
--   apply_roi_advance_recovery(p_user_id, p_roi_amount, ...)
--     Caller picks BOTH the agent and the claimed ROI amount; nothing verifies
--     that a ROI payout occurred. Capped only by the advance's outstanding
--     balance and the agent's withdrawable (create_ledger_transaction defaults
--     the wallet leg's bucket to 'withdrawable' from recipient_type='user', so
--     the solvency check does fire and the wallet cannot go negative).
--
--   collect_due_agent_advance_installment(p_agent_id)
--     Caller picks the agent; forces an off-schedule collection bounded by
--     get_agent_sweepable_withdrawable.
--
--   sweep_agent_advance_recovery()
--     No parameters, runs the whole book. Beyond the cash, it writes one
--     agent_advance_ledger row per advance per day INCLUDING not_due/ahead/
--     prepaid outcomes, and the next run skips any advance that already has a
--     row for the day. An anonymous call just after Kampala midnight therefore
--     consumes the day's slot for every advance while balances are empty, and
--     the real 19:50 cron (cron.job 13809) then collects nothing. It also
--     decrements prepaid_installments_remaining without collecting.
--
-- LEGITIMATE CALLERS (verified before writing this) - none of them affected
-- --------------------------------------------------------------------------
--   apply_roi_advance_recovery
--     supabase/functions/approve-wallet-operation/index.ts:441   service_role
--     supabase/functions/process-scheduled-payouts/index.ts:225  service_role
--     supabase/functions/process-supporter-roi/index.ts:301      service_role
--     public.pay_partner_self_cycles(integer)                    SECURITY DEFINER
--     cron.job 9250 'partner-self-payouts-daily'                 postgres
--   collect_due_agent_advance_installment
--     public.submit_withdrawal_request(...)                      SECURITY DEFINER
--       (reached from src/components/payments/WithdrawFlow.tsx:1058 as
--        `authenticated`, but only through that definer wrapper)
--   sweep_agent_advance_recovery
--     cron.job 13809 'sweep-agent-advance-recovery' (50 16 * * *) postgres
--
-- A nested call inside a SECURITY DEFINER function executes as the function's
-- owner (postgres), which keeps EXECUTE, so no wrapper is affected. Zero
-- frontend call sites exist: `src/` references all three only in the generated
-- src/integrations/supabase/types.ts.
--
-- OUT OF SCOPE - deliberately unchanged
-- ------------------------------------
-- service_role and postgres EXECUTE are untouched. No function body, no
-- ledger_account_map row, no GL posting, no wallet behaviour, no repayment
-- logic, and no change to global default privileges (ALTER DEFAULT PRIVILEGES
-- still grants EXECUTE to anon on every new function in `public`; changing
-- that needs its own inventory because some RPCs legitimately serve anonymous
-- pre-signup flows). scripts/guard-privileged-function-grants.mjs is the
-- regression guard for the interim.
--
-- Idempotent: REVOKE on an already-revoked privilege is a no-op.

REVOKE EXECUTE ON FUNCTION public.apply_roi_advance_recovery(uuid, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.collect_due_agent_advance_installment(uuid)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.sweep_agent_advance_recovery()
  FROM PUBLIC, anon, authenticated;
