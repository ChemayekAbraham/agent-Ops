# 117 — "Block landlord payouts from queue": allow selected payouts through (2026-09-24)

**Status: applied live to production 2026-09-24 and verified** (view, both claim RPCs and the
priority hold carry the new predicate; three new functions exist). The end-to-end check with the
block ON has not been run, because the flag was OFF and turning it on in production hides real
payouts from agents.

## Request

Josh: when the CTO toggle "Block landlord payouts from queue" (doc 37) is ON, the CTO should be able
to **see** the landlord payouts being held back and **select specific ones to allow** through to the
Merchant Agent Payout Queue, while the rest stay blocked.

## What was built

- **Exemption stamp**: `withdrawal_requests.landlord_block_exempt_at` / `landlord_block_exempt_by`.
  While the block is OFF the stamp does nothing.
- **One predicate**: `public.landlord_payout_queue_blocked(landlord_payout_id, exempt_at)`. It is
  true only when the row is a landlord payout, has no exemption, and the flag is ON. Every server read
  that used to check the flag alone now calls this:
  `v_merchant_payout_queue`, `claim_withdrawal_verified` (section C), `get_withdrawal_claim_status`
  ("unassigned" branch, plus `landlord_block_exempt_at` added to its narrow SELECT list).
- **Client fence**: `isQueueRowClientEligible` in `AgentCashPayoutsTab.tsx` now lets a row through
  when it has `landlord_block_exempt_at` set. The column was added to the two narrow candidate
  selects; the page query already uses `*`. Merchant agents can read the column through their
  existing `withdrawal_requests` RLS, so the doc-61 bug (client can't see what the server enforces)
  doesn't come back.
- **CTO RPCs** (cto / cfo / super_admin only, SECURITY DEFINER):
  - `get_landlord_payout_block_queue()` returns every open, unclaimed, non-hidden landlord
    payout with amount, landlord, agent, destination number and allow state.
  - `set_landlord_payout_block_exemption(ids uuid[], allow boolean)` returns the number of rows
    changed. It only touches unclaimed open rows, so re-blocking can never pull a payout away from
    a merchant who is paying it. It writes one `audit_logs` row per change.
- **UI**: `LandlordPayoutBlockExemptions.tsx` (hook `useLandlordPayoutBlockQueue.ts`) renders
  directly under the toggle in `PlatformControlsPanel.tsx`, **only while the toggle is ON**. It has
  checkboxes, "Allow selected", "Block selected again" and "Select all". The layout is deliberately
  plain so Gemini can restyle it.

## Also fixed (same predicate): landlord priority hold vs. block

Before this change, with **both** "Show Landlord Payouts first" and "Block landlord payouts" ON,
`assert_no_urgent_landlord_priority` still picked the oldest *hidden* landlord row as the hold.
Every other claim then failed with `CLAIM_PRIORITY_BLOCKED` on a payout merchants couldn't see. The
client already dropped the hold while blocked (doc 37), so the client and server disagreed. Now
blocked rows never hold the queue, and **allowed** landlord rows still do when priority is ON.
The client still disables its `blockingUrgentLandlord` banner whenever the block is ON. In that
combination the server can refuse a normal claim with "Priority Landlord payout must be processed
first" while that allowed row is visible in the list. This is acceptable, but the banner could be
made exemption-aware later.

## How it was applied

The view and the two claim RPCs were **patched in place from their live definitions**
(`pg_get_viewdef` / `pg_get_functiondef` → `replace` → assert the replacement happened →
`EXECUTE`). They were not re-declared from a repo copy. Re-declaring `claim_withdrawal_verified`
wholesale is how `20260916150000` silently dropped the payouts-freeze check (see doc 61, "Not the
cause"). If the live text has drifted, the migration raises an exception rather than overwriting.
None of the touched functions are in `critical_function_baselines`, so no re-baseline was needed.

## Files

- `supabase/migrations/20260924100000_landlord_payout_block_exemptions.sql`
- `src/hooks/useLandlordPayoutBlockQueue.ts` (new)
- `src/components/cto/LandlordPayoutBlockExemptions.tsx` (new)
- `src/components/cto/PlatformControlsPanel.tsx` (mount + description copy)
- `src/components/agent/AgentCashPayoutsTab.tsx` (client fence + selects)

## Verify

```sql
select
 pg_get_viewdef('public.v_merchant_payout_queue'::regclass,true) like '%landlord_payout_queue_blocked%' view_ok,
 (select prosrc like '%landlord_payout_queue_blocked%' from pg_proc where proname='claim_withdrawal_verified') claim_ok,
 (select prosrc like '%landlord_payout_queue_blocked%' from pg_proc where proname='get_withdrawal_claim_status') status_ok,
 (select prosrc like '%landlord_payout_queue_blocked%' from pg_proc where proname='assert_no_urgent_landlord_priority') prio_ok;
-- With the block ON: landlord rows in the view should equal the allowed count.
select count(*) from v_merchant_payout_queue where landlord_payout_id is not null;
select count(*) from withdrawal_requests where landlord_block_exempt_at is not null and assigned_cashout_agent_id is null and processed_at is null;
```

## Not done

- Exemptions are **not** auto-cleared when the toggle goes OFF. Allowed rows are normally paid
  quickly, and any leftover stamp only matters the next time the block is turned on.
- Still outstanding from doc 61: the live `claim_withdrawal_verified` is missing the
  `payouts_ui_enabled` freeze check. This change preserved the live body exactly and did not re-add it.
