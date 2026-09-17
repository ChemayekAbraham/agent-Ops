# 63 — CTO Platform Controls: "Pause landlord float withdrawals" toggle (2026-09-17)

**Status: written, migration NOT yet applied to production** (blocked by the auto-mode
classifier as a "modify shared resources" action when attempted directly against the live DB —
must go through the normal migration deploy path). Verify with the block below before trusting
this is live.

## What was requested

A CTO Platform Controls toggle so agents cannot withdraw their Agent Landlord Payout Float.

## Why this is a new, distinct toggle

[[project doc 37]] (`docs/HANDOVER/37-block-landlord-payouts-from-queue-toggle.md`) already added
`landlord_payouts_blocked`, but that only hides **already-created** landlord payout
`withdrawal_requests` rows from the Merchant Agent Payout Queue — it explicitly does **not** stop
new landlord payouts from being created (its own "What not to do" section says so). This request
is the other half doc 37 called out as a separate change: stop the agent from drawing the float
down at all, at the point of creation.

`agent_landlord_float` (see `src/hooks/useAgentLandlordFloat.ts`) is a CFO-allocated pool separate
from wallet float — this is the "landlord payout float" the request refers to. An agent spends it
down by disbursing to a landlord via `landlord-payout-disburse`, which inserts a row into
`landlord_payouts`. That insert is gated by a single BEFORE INSERT trigger,
`enforce_landlord_payout_eligibility()` — the one authoritative choke point for every writer of
this table.

## What was built

- New `treasury_controls` flag, `landlord_float_withdrawals_paused` (default `false`).
- Helper `public.landlord_float_withdrawals_paused()`, mirroring the `landlord_payouts_blocked_from_queue()`
  pattern from doc 37.
- `enforce_landlord_payout_eligibility()` now raises first, before any of its existing checks
  (Kampala operating hours, landlord verification, float sufficiency), when the flag is ON.
  Because this trigger is the only path into `landlord_payouts`, this covers
  `landlord-payout-disburse` today and any future writer for free — no edge-function-side
  duplicate check was added (avoids the "two independent copies of the same rule drift apart"
  failure mode from [[project_merchant_oop_settlement_rpc_evidence_gap]]).
- The edge function's existing `insertErr?.message` fallback already surfaces the trigger's raised
  message straight to the UI toast — no changes needed in `landlord-payout-disburse/index.ts` or
  `AgentFloatPayoutWizard.tsx`.
- New toggle added to `PlatformControlsPanel.tsx`, "Emergency halts" group, alongside
  `advance_withdrawals_paused` (`danger: true`).

## Scope decisions

- Turning this ON does **not** touch landlord payouts already sitting in the merchant payout
  queue — those keep flowing through Financial Ops. Combine with `landlord_payouts_blocked` (doc
  37) if you also want to hide/freeze those.
- No RLS/public-read change was needed: the flag is read only by the SECURITY DEFINER trigger and
  by `PlatformControlsPanel.tsx`, and the CTO already has unconditional SELECT on
  `treasury_controls`. (Contrast with doc `20260917110000`, where a *different* flag needed a
  public RLS grant because a plain agent's browser read it directly — that gap doesn't apply here
  since no agent-facing client code reads this new key.)

## Files

- `supabase/migrations/20260917120000_landlord_float_withdrawal_pause_toggle.sql` (new)
- `src/components/cto/PlatformControlsPanel.tsx`

## Verify this is live (run after the migration is actually deployed)

```sql
select control_key, enabled from public.treasury_controls where control_key = 'landlord_float_withdrawals_paused';
select prosrc like '%landlord_float_withdrawals_paused%' from pg_proc where proname = 'enforce_landlord_payout_eligibility';

-- End-to-end: flip it on, confirm a landlord_payouts insert is refused, then flip back off.
update public.treasury_controls set enabled = true where control_key = 'landlord_float_withdrawals_paused';
-- (attempt a disbursement via the app or landlord-payout-disburse; expect a 400 with the pause message)
update public.treasury_controls set enabled = false where control_key = 'landlord_float_withdrawals_paused';
```

## What not to do

- Don't confuse this with `landlord_payouts_blocked` — they are independent and can be combined.
- Don't add a second, edge-function-side copy of this check — the trigger is the single source of
  truth precisely so it can't drift from what the panel controls.
- Don't trust the migration file alone — per this repo's standing failure mode (docs 06, 07, 17,
  18, 29, 31, 34, 36, 37), a committed migration is not necessarily an applied one. Run the verify
  block above against production.
