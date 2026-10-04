# 37 — CTO Platform Controls: "Block landlord payouts from queue" toggle (2026-09-16)

**Status: fixed, verified live in production (2026-09-16).** Deployed and confirmed: the
`landlord_payouts_blocked` control row exists (default `false`), `landlord_payouts_blocked_from_queue()`
exists, and `v_merchant_payout_queue`, `claim_withdrawal_verified`, and `get_withdrawal_claim_status`
all carry the fix (checked via `pg_get_viewdef`/`prosrc` against live production, not the migration
file — see the verify block below, which is exactly what was re-run to confirm this).

## What was requested

A CTO Platform Controls toggle that blocks landlord payouts from appearing in the Merchant
Agent Payout Queue.

## What was built

A new `treasury_controls` flag, `landlord_payouts_blocked` (default `false`), following the
existing toggle pattern (`landlord_payout_priority`, `payouts_ui_enabled`). Deliberately
distinct from the existing `hidden_from_merchant_queue` column — that's a per-row, FinOps-only
manual hide; this is a single platform-wide switch scoped specifically to
`landlord_payout_id IS NOT NULL` rows.

Per the doc-35 lesson (a flag that only hides a row from the browsed list is not a real block
if the claim RPC doesn't re-check it), the flag is enforced in three places, all reading one
helper function `public.landlord_payouts_blocked_from_queue()`:

1. **`v_merchant_payout_queue`** (the queue-listing view) — added
   `AND (landlord_payout_id IS NULL OR NOT landlord_payouts_blocked_from_queue())`.
2. **`claim_withdrawal_verified(uuid,text,text)`** — added the same condition to section C
   ("Same fence as the merchant queue"), so a merchant cannot claim a landlord payout by id
   even if they already had it open/cached before the toggle flipped ON.
3. **`get_withdrawal_claim_status(uuid)`** — same condition added to its "unassigned" branch
   (also had to add `landlord_payout_id` to its SELECT list — unlike `claim_withdrawal_verified`
   which does `SELECT *` into a `%ROWTYPE`, this one uses a narrow explicit column list).

Turning the toggle ON does **not** cancel or touch existing landlord withdrawal requests —
they just stop appearing/being claimable and reappear the instant it's turned back OFF. New
landlord payout requests can still be *created* (`landlord-payout-disburse` is untouched); they
simply sit invisible in the queue while the flag is ON. This was a deliberate scope decision —
the ask was about queue *appearance*, not about stopping landlord payouts from being generated.

Client-side, the actual queue widget (`AgentCashPayoutsTab.tsx`) queries
`public.withdrawal_requests` directly with its own client-side fence
(`applyQueueFilters` / `isQueueRowClientEligible`), **not** the view — so the view fix alone
would not have changed what a merchant agent actually sees. Wired a new
`useLandlordPayoutsBlocked()` hook (mirrors `useLandlordPayoutPriority`) into all three of that
file's queue queries (`cashout-queue-available-total`, `cashout-queue-counts`,
`cashout-queue-page`) via a new `QueueFilterOpts.landlordPayoutsBlocked` field, checked in
`isQueueRowClientEligible` ahead of the existing landlord/standard status-tab filter (so it
takes precedence even if someone explicitly selects the "landlord" filter tab). Also disabled
the `blockingUrgentLandlord` priority-hold query while the block is ON — a hidden row must never
be allowed to silently freeze every other payout in the queue via the priority mechanism.

New toggle added to `PlatformControlsPanel.tsx`, "Payout queue & UI overrides" group, right
after "Show Landlord Payouts first" (`danger: true` styling — this is a halt, not a protective
default-on guard).

## Files

- `supabase/migrations/20260916150000_block_landlord_payouts_from_queue_toggle.sql`
- `src/hooks/useLandlordPayoutsBlocked.ts` (new)
- `src/components/cto/PlatformControlsPanel.tsx`
- `src/components/agent/AgentCashPayoutsTab.tsx`

## Verify this is still live

```sql
-- Row should exist, default false:
select control_key, enabled from public.treasury_controls where control_key = 'landlord_payouts_blocked';

-- All three should reflect the fix (not stale drift — see doc 06/07/17):
select pg_get_viewdef('public.v_merchant_payout_queue'::regclass, true) like '%landlord_payouts_blocked_from_queue%' as view_fix;
select prosrc like '%landlord_payouts_blocked_from_queue%' from pg_proc where proname = 'claim_withdrawal_verified';
select prosrc like '%landlord_payouts_blocked_from_queue%' from pg_proc where proname = 'get_withdrawal_claim_status';

-- End-to-end: flip it on, confirm zero landlord rows are queue-visible.
update public.treasury_controls set enabled = true where control_key = 'landlord_payouts_blocked';
select count(*) from public.v_merchant_payout_queue where landlord_payout_id is not null; -- expect 0
-- then flip back off:
update public.treasury_controls set enabled = false where control_key = 'landlord_payouts_blocked';
```

## What not to do

- Don't confuse this with `hidden_from_merchant_queue` (per-row FinOps manual hide) or
  `landlord_payout_priority` (reorders, doesn't hide). All three are independent and can be
  combined.
- Don't assume flipping this ON also stops new landlord payouts from being created — it
  doesn't, by design. If a full stop is ever wanted, that's a separate change to
  `landlord-payout-disburse`.
- Don't trust the toggle is enforced just because the migration file exists — this repo's
  standing failure mode (docs 06, 07, 17, 18, 29, 31, 34, 36) is a migration that was written
  and committed but never actually applied live. Run the verify queries above first.
