-- ═══════════════════════════════════════════════════════════════════════════
-- Agent Landlord Payout Float — "Available to pay: UGX 0" while float is held
--
-- Symptom: the Pay Landlord wizard shows a real float balance but
-- "Available to pay: UGX 0 · UGX X is already held by landlord payouts
-- awaiting cash-out". Run 1–3 BEFORE applying migration
-- 20260826130000_release_stuck_landlord_payout_float_holds.sql to size the
-- problem, and 4–5 after, to confirm it cleared.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Every agent whose float is fully or mostly withheld ────────────────
-- balance vs the old reservation rule (all otp_verified / pending_merchant_payout).
SELECT
  f.agent_id,
  p.full_name,
  f.balance,
  COALESCE(h.reserved, 0)                        AS reserved_old_rule,
  GREATEST(0, f.balance - COALESCE(h.reserved, 0)) AS available_old_rule,
  h.hold_count
FROM public.agent_landlord_float f
LEFT JOIN public.profiles p ON p.id = f.agent_id
LEFT JOIN LATERAL (
  SELECT SUM(lp.amount) AS reserved, COUNT(*) AS hold_count
  FROM public.landlord_payouts lp
  WHERE lp.agent_id = f.agent_id
    AND lp.status IN ('otp_verified','pending_merchant_payout')
) h ON TRUE
WHERE COALESCE(f.balance, 0) > 0
  AND COALESCE(h.reserved, 0) > 0
ORDER BY (f.balance - COALESCE(h.reserved, 0)) ASC;

-- ─── 2. What is holding each hold, and is it real? ─────────────────────────
-- hold_state:
--   holding_live                  → backing merchant withdrawal still alive
--   holding_unlinked              → no withdrawal yet, payout < 24h old
--   holding_settled_needs_review  → withdrawal completed but payout never
--                                   advanced; needs a float-debit check
--   released_dead_withdrawal      → withdrawal rejected/cancelled/failed/
--                                   expired/reversed → stuck, float never debited
--   released_orphaned             → no withdrawal at all, payout > 24h old → stuck
--
-- (Requires the migration for the view. Before applying, run the same CASE
-- inline against landlord_payouts LEFT JOIN withdrawal_requests.)
SELECT
  h.agent_id,
  p.full_name              AS agent_name,
  h.landlord_name,
  h.amount,
  h.payout_status,
  h.withdrawal_status,
  h.hold_state,
  h.payout_created_at,
  age(now(), h.payout_created_at) AS stuck_for
FROM public.agent_lp_float_holds h
LEFT JOIN public.profiles p ON p.id = h.agent_id
ORDER BY h.hold_state, h.payout_created_at;

-- ─── 3. Money at stake, by hold state ──────────────────────────────────────
SELECT hold_state, COUNT(*) AS payouts, SUM(amount) AS ugx
FROM public.agent_lp_float_holds
GROUP BY hold_state
ORDER BY ugx DESC NULLS LAST;

-- ─── 4. Release the stranded holds ─────────────────────────────────────────
-- Closes only 'released_*' rows (backing withdrawal dead or missing). Credits
-- NOTHING back: those payouts were never debited from the float — the debit
-- happens in approve-withdrawal at settlement. Omit the argument for all
-- agents, or pass one agent's id.
--   SELECT public.reconcile_stuck_landlord_payout_holds();
--   SELECT public.reconcile_stuck_landlord_payout_holds('<agent_uuid>');
-- (The migration already runs this once for the existing backlog.)

-- ─── 5. Confirm the agent can spend again ──────────────────────────────────
SELECT
  f.agent_id,
  p.full_name,
  f.balance,
  public.get_agent_lp_float_available(f.agent_id) AS available_now,
  f.balance - public.get_agent_lp_float_available(f.agent_id) AS still_reserved
FROM public.agent_landlord_float f
LEFT JOIN public.profiles p ON p.id = f.agent_id
WHERE COALESCE(f.balance, 0) > 0
ORDER BY available_now ASC;

-- ─── 6. Settled-but-stuck rows — manual Financial Ops review ───────────────
-- These are NOT auto-released. The merchant withdrawal completed (money left)
-- but the payout row never advanced past pending_merchant_payout, so either
-- the float debit ran and the hold is a double-count, or the debit never ran
-- and the balance is overstated. Check general_ledger / agent_landlord_float
-- history per row before touching it.
SELECT h.*, p.full_name AS agent_name
FROM public.agent_lp_float_holds h
LEFT JOIN public.profiles p ON p.id = h.agent_id
WHERE h.hold_state = 'holding_settled_needs_review'
ORDER BY h.payout_created_at;
