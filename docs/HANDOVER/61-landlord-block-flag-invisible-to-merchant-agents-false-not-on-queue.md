# 61 — "No longer on payout queue" on every claim: the block flag was invisible to the agents whose queue it filters

**Reported 2026-09-17** by Josh: *"ALL PAYOUTS ON THE QUEUE ARE SHOWING A FALSE NOTIFICATION... Am
trying to pay but wen i tap on the claim part it refuses."*

## Symptom

Merchant Agents saw payouts sitting in the Pending Queue, tapped **Claim**, and got rejected with
*"This withdrawal is no longer in the payout queue."* — repeatedly, on the same rows, seconds apart.

## Confirmed against production

`withdrawal_claim_attempts`, last 24h:

| result_code | error_code | count |
|---|---|---|
| CLAIM_NOT_ACTIONABLE | `not_available` | **100** |
| CLAIM_SUCCESS | — | 61 |
| CLAIM_ALREADY_OWNED_BY_OTHER | `already_claimed` | 11 |
| CLAIM_BLOCKED_ACTIVE_CLAIM | `active_claim_exists` | 6 |
| CLAIM_PRIORITY_BLOCKED | `proxy_priority_hold` | 3 |
| CLAIM_NOT_ACTIONABLE | `id_not_verified` | 2 |

Every one of the 100 `not_available` rows had `landlord_payout_id` set, status still `pending`, not
processed, not hidden, not fin-ops-referenced — i.e. genuinely still open. `treasury_controls` had
`landlord_payouts_blocked = true` at the time (the CTO's "Block landlord payouts from queue" toggle,
[`37-block-landlord-payouts-from-queue-toggle.md`](./37-block-landlord-payouts-from-queue-toggle.md)).

## Root cause

Migration `20260916150000_block_landlord_payouts_from_queue_toggle.sql` wired the new
`landlord_payouts_blocked` flag into **three** server-side reads: the `v_merchant_payout_queue`
view, `claim_withdrawal_verified`, and `get_withdrawal_claim_status`. All three agree, correctly.

It missed a **fourth** read: the client itself. `useLandlordPayoutsBlocked()`
(`src/hooks/useLandlordPayoutsBlocked.ts`) queries `treasury_controls` as the signed-in Merchant
Agent to decide whether `isQueueRowClientEligible()` in `AgentCashPayoutsTab.tsx` should hide
landlord rows from the rendered queue. That query goes through RLS as the agent's own role — and
the `"Public can read maintenance and payout flags"` policy's `control_key` allow-list
(`maintenance_mode`, `payouts_ui_enabled`, `landlord_payout_priority`, …) was never given
`landlord_payouts_blocked`. A Merchant Agent holds none of the other `treasury_controls` SELECT
policies (cto / cfo / manager / super_admin / ceo), so the row was invisible to them: the query
returned zero rows, `data` was `null`, and `setBlocked(!!data?.enabled)` silently landed on `false`
— for every agent, always, regardless of the real flag value.

Net effect: the client kept showing landlord payouts as claimable (flag read as off), while the
SECURITY DEFINER claim RPC — unaffected by this RLS gap, it runs as the function owner — correctly
enforced the block and refused every one of them.

This is the same shape of bug the migration's own commit message warned about (a flag that only
hides a row from the browsed list is not a real block unless every read path agrees) — it just
missed that "every read path" included the browser's own RLS-gated read of the flag, not only the
claim RPC's internal check.

## Fix

`20260917110000_landlord_payouts_blocked_flag_rls_read.sql` — adds `landlord_payouts_blocked` to
the same public allow-list its sibling queue flags already sit in. Applied directly to production
(RLS policy change only, no data touched) and committed as a migration for the repo to match.

```sql
CREATE POLICY "Public can read maintenance and payout flags"
ON public.treasury_controls FOR SELECT
TO anon, authenticated
USING (control_key = ANY (ARRAY[
  'maintenance_mode','maintenance_message','maintenance_until',
  'payouts_ui_enabled','withdrawals_paused','proxy_payout_priority',
  'landlord_payout_priority','landlord_payouts_blocked'
]));
```

This only exposes the boolean switch itself (on/off), not any financial data — the same exposure
its five siblings in that allow-list already have.

## Not the cause (ruled out)

- `payouts_ui_enabled` is `true` — the platform-wide payout freeze is off.
- The freeze check added in `20260916140000_enforce_payouts_ui_flag_on_claims.sql` is gone from the
  live `claim_withdrawal_verified` — `20260916150000` replaced the function again and didn't carry
  it forward. Not today's symptom (the flag it guards is off), but worth a follow-up: re-add that
  check the next time `claim_withdrawal_verified` is touched, or it silently stops enforcing the
  freeze the next time someone flips `payouts_ui_enabled` off.
- The 2 `id_not_verified` and 3 `proxy_priority_hold` rejections in the same window are unrelated,
  correctly-enforced blocks, not this bug.

## If this recurs for a different flag

Any new `treasury_controls` boolean that a plain agent's browser needs to read (not just a
privileged-role admin panel) needs its `control_key` added to `"Public can read maintenance and
payout flags"` explicitly — being read by a `SECURITY DEFINER` RPC does **not** make it readable by
the client that has to decide what to show *before* calling that RPC.
