# 30. Agent collections blocked/silently dropped: guard drifted behind a live float redesign (2026-09-16)

**Severity:** P1 (every agent's first collection on a plan hard-failed; every later collection on
an already-`repaying` plan silently did not record the payment, while still paying commission).
**Read this before touching:** `guard_rent_request_agent_updates`,
`agent_allocate_tenant_payment_internal`, or the Confirm Payment dialog in
`AgentTenantCollectDialog.tsx`.

---

## What triggered this

Agent Nattu Sharifah (0781515171) reported "I can't pay for a tenant." Screenshot showed the
Confirm Payment dialog for tenant Mugisha David with a red banner: *"Could not complete
allocation — Agents cannot move a rent request from funded to repaying."*

## Root cause

Sometime around **2026-09-15 15:12 UTC**, `agent_allocate_tenant_payment_internal` was redesigned
directly in production — **not reflected in any migration file in this repo** (another instance of
the drift class documented in
[`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md)). The
redesign is a real, apparently-intentional design change: agent float becomes a non-consuming
eligibility gate ("Float is an allowance... no longer consumed as if it were physical cash", per
the live function's own comment) instead of cash that gets debited per collection. As part of
that, it stopped writing the `agent_float_used_for_rent` / `tenant_repayment` wallet-float ledger
legs.

`guard_rent_request_agent_updates` (the trigger that lets an agent's own `UPDATE` to
`rent_requests.amount_repaid`/`status` through — see
[`20260910130000_guard_trusted_allocation_per_collection.sql`](../../supabase/migrations/20260910130000_guard_trusted_allocation_per_collection.sql))
still required one of those two now-dead ledger shapes before trusting the write. It was never
updated to match the redesign, so from the cutoff onward:

- **First payment on a plan** (`funded`/`disbursed`/`approved` → `repaying`): the guard finds no
  trusted shape and hard-blocks the status change with `RAISE EXCEPTION 'Agents cannot move a rent
  request from % to %'`. This is what Nattu Sharifah hit. Confirmed live: rent_request
  `d00189d1-2721-458e-b5b9-8f3f042b4a79` (Mugisha David, total 419,000) is still `status='funded'`,
  `amount_repaid=0` after the attempt — the whole transaction rolled back cleanly, no partial
  writes, no money lost.
- **Any later payment on an already-`repaying` plan**: no exception (status isn't changing), so
  the RPC returns `success: true`, commission is paid, and the `tenant_repayment_collected` /
  `cash_receipt_in_transit` / `agent_commission_*` ledger legs are all written correctly — but the
  guard silently reverts `NEW.amount_repaid` to `OLD.amount_repaid`. Confirmed live: rent_request
  `294797c8-0c1a-4a31-ac82-00d8560173ee` took three separate 20,000 collections inside one minute
  (05:35:36, 05:35:48, 05:36:01 UTC) and `amount_repaid` read `226,000` after all three — frozen,
  not accumulating.

Blast radius as measured 2026-09-16: **660 `agent_collections` rows totalling UGX 73,768,785**
posted since the 2026-09-15 15:12 UTC cutoff. Every one of them has correct ledger accounting
(commission, cash-in-transit custody, tenant receivable leg) but a `rent_requests.amount_repaid`/
`status` that does not reflect the payment (either frozen at the pre-cutoff value, or — for
first-payment attempts — never mutated at all because the whole RPC rolled back).

## The fix

`20260916060000_guard_trusted_allocation_receivable_shape.sql` — added a third trusted-allocation
shape to the guard, matching what the RPC actually writes today: the `tenant_repayment_collected`
cash_out leg on `ledger_scope='platform'`, pinned to this exact rent request
(`source_table='agent_collections'`, `source_id = OLD.id`), this tenant (`user_id = NEW.tenant_id`),
the exact repayment delta, in this transaction (`xmin = v_this_xid`). This leg is written for
*every* collection under the current design, so it's at least as strong a trust signal as the
wallet-float legs it replaces — arguably stronger, since it directly represents "this rent
request's receivable was reduced by exactly this amount right now" rather than an indirect float
debit.

The two legacy shapes (`agent_float_used_for_rent`, `tenant_repayment`) were left in place rather
than removed — they simply never match any more, and keeping them costs nothing if the wallet-float
leg ever comes back.

**Applied directly to production** (`CREATE OR REPLACE FUNCTION`, same statement as the migration
file) because agents were actively blocked from collecting rent at the time. Migration file also
committed so the repo reflects it. Verify it's live:

```sql
SELECT
  position('tenant_repayment_collected' in prosrc) > 0 AS has_new_shape,
  position('agent_float_used_for_rent' in prosrc) > 0 AS has_legacy_shape
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'guard_rent_request_agent_updates';
-- both true as of 2026-09-16
```

Did **not** perform a live test collection to confirm end-to-end — that would move real commission
and ledger entries for a real agent/tenant. Confidence instead comes from directly matching the
new SQL predicate against real `tenant_repayment_collected` rows already in `general_ledger`
(source_id/user_id/category/direction/ledger_scope/amount all lined up exactly as written). Next
agent who collects rent on a `funded` plan is the real end-to-end proof — watch for a recurrence
of "Agents cannot move a rent request" after this deploy.

## What's still open — do not assume this is done

1. **660 collections since the 2026-09-15 15:12 UTC cutoff need `rent_requests.amount_repaid` and
   `status` backfilled from the ledger.** The ledger (`general_ledger`, `agent_collections`) is
   accurate — it's `rent_requests` that's stale. This needs a careful per-plan reconciliation
   (sum `agent_collections.amount` per `rent_request_id` since the plan's pre-cutoff baseline,
   re-derive `status` the same way the RPC does), not a blind `UPDATE`, and was deliberately not
   attempted in this session. Until it runs, tenant outstanding balances shown to agents for any
   plan that took a payment since 2026-09-15 15:12 UTC are wrong (too high), and dashboards/arrears
   built on `rent_requests.amount_repaid` will overstate what's still owed.
2. **The underlying float redesign in `agent_allocate_tenant_payment_internal` is still undocumented
   anywhere in this repo.** Only this guard-side fix is captured. If the redesign has other
   downstream assumptions (anything else that expected an `agent_float_used_for_rent` leg to exist
   per collection — reporting, reconciliation, the arrears skill's collected-vs-expected math),
   they have the same drift risk this doc just fixed for the guard. Worth a targeted grep for
   `agent_float_used_for_rent` across `src/` and `supabase/functions/` before trusting anything else
   that touches agent float.
3. **How the redesign shipped to production without a migration file is unknown.** Same open
   question `17` and `18` already raised for other functions — there is still no reliable signal in
   this repo for "a SECURITY DEFINER function changed in prod." Re-run
   `scan_critical_function_drift()` (see `17`) and consider adding
   `agent_allocate_tenant_payment_internal` and `guard_rent_request_agent_updates` to
   `critical_function_baselines` if they aren't already there.

## What not to do

- Don't remove the two legacy shapes from the guard — they're free insurance, not clutter.
- Don't bulk-`UPDATE rent_requests.amount_repaid` from a rough sum without also re-deriving
  `status` the same way the RPC does (`completed` once `amount_repaid >= total_repayment`,
  `repaying` otherwise) — a naive backfill can leave a fully-paid plan stuck at `repaying`.
- Don't treat "the RPC returned `success: true`" as proof a collection actually landed on
  `rent_requests` for anything dated between 2026-09-15 15:12 UTC and this fix's deploy — check
  `general_ledger` directly for that window instead.
