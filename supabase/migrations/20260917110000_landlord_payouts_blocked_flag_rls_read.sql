-- Bug: "Every payout in the queue says it's no longer on the payout queue
-- when I tap Claim" (reported 2026-09-17, live).
--
-- Root cause, confirmed against production (withdrawal_claim_attempts, 100
-- `not_available` claim failures in the last 24h, all on rows with
-- landlord_payout_id set):
--
-- 20260916150000_block_landlord_payouts_from_queue_toggle.sql added the
-- `landlord_payouts_blocked` treasury_controls flag and wired it into THREE
-- server-side reads (v_merchant_payout_queue, claim_withdrawal_verified,
-- get_withdrawal_claim_status) plus a FOURTH, client-side read:
-- useLandlordPayoutsBlocked() (src/hooks/useLandlordPayoutsBlocked.ts), which
-- a plain Merchant Agent's browser uses to decide whether to hide landlord
-- rows from the queue it renders (AgentCashPayoutsTab.tsx passes the result
-- into isQueueRowClientEligible's `landlordPayoutsBlocked` check).
--
-- That client read goes through ordinary PostgREST as the agent's own
-- session, gated by RLS -- and the "Public can read maintenance and payout
-- flags" policy's control_key allow-list was never given
-- 'landlord_payouts_blocked'. A Merchant Agent has none of the other
-- treasury_controls SELECT policies (cto / cfo / manager / super_admin /
-- ceo), so the row is invisible to them: the hook's query returns no rows,
-- `blocked` silently defaults to `false`, and their queue keeps showing
-- landlord payouts as claimable. The claim RPC (SECURITY DEFINER, unaffected
-- by this RLS gap) then correctly refuses every one of them with
-- 'not_available' / "This withdrawal is no longer in the payout queue."
--
-- Fix: add 'landlord_payouts_blocked' to the same public read allow-list the
-- other queue-facing flags already use (payouts_ui_enabled,
-- landlord_payout_priority, ...). This only exposes the boolean switch
-- itself, not any financial data, matching those siblings.

DROP POLICY IF EXISTS "Public can read maintenance and payout flags" ON public.treasury_controls;
CREATE POLICY "Public can read maintenance and payout flags"
ON public.treasury_controls FOR SELECT
TO anon, authenticated
USING (control_key = ANY (ARRAY[
  'maintenance_mode','maintenance_message','maintenance_until',
  'payouts_ui_enabled','withdrawals_paused','proxy_payout_priority',
  'landlord_payout_priority','landlord_payouts_blocked'
]));
