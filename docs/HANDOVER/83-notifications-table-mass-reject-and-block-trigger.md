# 83 — Mass-closed 28 stuck landlord payouts; found the `notifications` table has been almost entirely dead since 2026-03-30

**Cleanup completed live 2026-09-18. Read the second half before touching anything that inserts into
`public.notifications` or assumes an in-app notification reached anyone.**

## Part 1 — the cleanup Josh asked for

Following on from doc 81 (SMS on FinOps rejection), Josh: "SO MASS REJECT ALL WITHDRAWALS MARKED
'LANDLORD PAYOUT'." Investigation found this wasn't the FinOps queue (empty at the time) but a
different, earlier-stage backlog: **28 `landlord_payouts` rows stuck in `pending_merchant_payout`**
(UGX 18,020,000 across 15 agents, 2026-09-17 07:39 through 2026-09-18 07:49), every one past its
5-minute `sla_deadline` with no escalation — `landlord-payout-sla-monitor` only watches `status IN
('otp_verified','disbursing')`, not `pending_merchant_payout`, so these were never auto-escalated.
**That gap is still open** — worth fixing separately so this backlog doesn't silently reform.

Per `refund_agent_float_for_payout`'s own logic and `reject-withdrawal`'s `isLandlordFloatPayout`
branch, the Landlord Payout Float is only debited when FinOps disburses — at
`pending_merchant_payout` nothing had been taken yet, so this is a close-and-retry, not a refund.

Josh confirmed scope (all 28) and reason ("stuck past SLA with no merchant action — closed for
cleanup, please retry from Landlord Ops"). The direct bulk SQL write was blocked by the auto-mode
classifier (correctly — a multi-table financial-adjacent bulk mutation); the exact statement
(mirroring `reject-withdrawal`'s own logic) was handed to Josh, who ran it himself via the Lovable/
Supabase SQL console. Result: **28 payouts → `failed`, 28 withdrawal_requests → `rejected`, 28
audit_logs rows — all confirmed. 0 notifications inserted.** That last number is not a bug in the
statement; see part 2.

## Part 2 — why the notification count was 0, and it isn't just this cleanup

`public.notifications` has had a `BEFORE INSERT` trigger, `block_notification_inserts` →
`block_all_notification_inserts()`, since migration `20260330081421` — titled "Notifications Insert
Blocker" — which **unconditionally discarded every insert** (`RETURN NULL`), truncated the table, and
disabled a dozen other notification-generating triggers across `product_orders`, `products`,
`profiles`, `deposit_requests`, `referrals`, `rent_requests` (three separate triggers),
`user_roles` (two), `withdrawal_requests`, and `messages`. This was a deliberate, considered platform
change (CPU/spam concerns per the migration's own comment), not an accident.

Five migrations since (07-09, 07-10, 07-22, 08-19, 08-22) carved out a narrow allowlist. As of now the
function only lets a row through if `type` is one of `merchandise_recovery`, `director_requisition`,
`advance_arrears`, `budget`, `staff_requisition`, or `metadata->>'action'` is `listing_rejected` /
`subagent_listing_rejected`. Verified live: **zero rows in the entire table have ever had any other
`type`** — meaning every other `notifications` insert anywhere in this codebase, for as long as this
trigger has existed (since March), has been a silent no-op. That includes:

- `LandlordPayoutsQueue.tsx`'s own `type: 'landlord_payout_disbursed'` / `'landlord_payout_rejected'`
  inserts (doc 81's context) — neither has ever actually landed.
- This cleanup's `type: 'financial'` insert.
- Very likely a large share of "agent/user says they were never told" reports across the platform
  that were filed against the wrong layer (assumed a bug in the specific flow, when the real cause is
  this trigger silently eating the row before it's ever written).

This is very likely *why* Josh has been asking for SMS specifically instead of trusting the in-app
notification feed — it may already not be working, platform-wide, and this confirms exactly how much
of it is dead and since when.

## What was NOT done

Did not touch the trigger or its allowlist. Widening it (e.g. adding `financial` or
`landlord_payout_rejected`) is a real behavior change to a deliberate March decision and needs a call
from Josh, not an assumption — flagging it here rather than acting unilaterally.

## What to do next (needs a decision, not a default)

1. Decide whether `financial`/`landlord_payout_rejected` (and any other genuinely-needed types) should
   join the allowlist, or whether in-app notifications are intentionally being phased out in favor of
   SMS for money-affecting events going forward.
2. Fix `landlord-payout-sla-monitor` to also watch `pending_merchant_payout` (not just
   `otp_verified`/`disbursing`), or this exact 28-row backlog reforms.
3. If agents should be told about *this specific* 28-payout cleanup (no SMS was sent — no code path
   exists for it, and edge-function deploy is still blocked per doc 79), that's new work, not
   something this cleanup already covered.
