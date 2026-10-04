# 81 — Agents now get an SMS when Financial Ops rejects their landlord payout

**Feature added, not yet deployed (frontend change is live once merged; the new edge function
`notify-landlord-payout-rejected` needs a manual deploy via `deploy-edge-function.yml`). Before
touching `LandlordPayoutsQueue.tsx`'s `handleReject`, or if an agent says they were never told a
landlord payout was rejected.**

## What was asked

Josh, 2026-09-18: when a landlord payout withdrawal is rejected at Financial Ops, the agent should
get an SMS saying it was rejected and that their float is back ("in the ring") so they can withdraw
again.

## What was found

`LandlordPayoutsQueue.tsx`'s `handleReject` (the FinOps queue's Reject button, for rows in
`landlord_payouts` with `status = 'pending_finops_disbursement'`) already:
1. calls `refund_agent_float_for_payout(p_payout_id, p_reason)` — a `SECURITY DEFINER` RPC, verified
   live, that credits `agent_landlord_float.balance` back by the payout amount, reopens the
   allocation if one applied, and sets `landlord_payouts.status = 'failed'`;
2. inserts an in-app `notifications` row telling the agent the same thing.

Nothing sent an SMS. The in-app notification is easy to miss for an agent mid-round with the app
backgrounded, which is exactly when "you can withdraw again now" matters most.

Two other, unrelated things that look similar were checked and are NOT the same code path:
- `reject-withdrawal`'s `isLandlordFloatPayout` branch (its comment: as of 2026-07-24 the float is
  only debited at FinOps approval, so a rejection *there* never needs a refund) — that's an earlier
  merchant-side rejection stage, before FinOps ever sees the payout. It does send SMS for the
  ordinary (non-landlord-float) case, but not for this branch either — a separate, pre-existing gap
  not touched here since no refund happens there.
- `LandlordOpsPayoutReview.tsx`'s `rejectMutation` writes to a different table
  (`agent_landlord_payouts`, not `landlord_payouts`) with no float-refund RPC call at all. Left
  alone — "float back in the ring" doesn't apply to a flow that never touches the float.

## What was done

New edge function `supabase/functions/notify-landlord-payout-rejected/index.ts` (modeled on
`landlord-rent-receipt`'s structure): takes `{ payout_id, reason }`, authenticates a staff JWT
(operations/cfo/manager/super_admin/coo), confirms the payout is actually `status = 'failed'` (so it
can only ever fire for this exact rejection, never mid-flight or twice), looks up the agent's phone,
and SMSes:

> Welile: Your landlord payout of UGX X to `<landlord>` was REJECTED by Financial Ops. Reason:
> `<reason>`. Your Landlord Payout Float has been returned — you can withdraw again.

via the shared `sendSmsMultiProvider.ts` (Yoola → Africa's Talking → Lana), with
`idempotencyKey: landlord-payout-rejected-<payout_id>` so a double-click or retry can't double-send.

`handleReject` now calls this function (fire-and-forget, same non-blocking pattern as the existing
in-app notification insert — an SMS failure must never re-open or reverse the rejection/refund).

Added `notify-landlord-payout-rejected` to `deploy-edge-function.yml`'s choice list (default posture:
authenticates via the Authorization header, no `config.toml` entry needed). **Per doc 79, this
workflow currently cannot deploy anything at all** — `weliletenants-sys/welilereceipts-com-98bba33b`
has zero GitHub Actions secrets configured, so `SUPABASE_ACCESS_TOKEN` doesn't exist and every run
fails in ~17s before calling `supabase functions deploy`. This function needs the same fix as doc
79/80 before it can go live — don't assume it's live just because it's committed and choosable.

## What not to do

- Don't wire this into `reject-withdrawal`'s `isLandlordFloatPayout` branch or
  `LandlordOpsPayoutReview.tsx` without confirming those paths actually refund the float first — an
  SMS saying "your float is back" would be a lie on a path that never touched it.
- Don't skip the `status !== 'failed'` guard in the edge function if you ever call it from a new call
  site — it's what stops this from firing on a payout that's merely pending or already refunded by
  something else.
