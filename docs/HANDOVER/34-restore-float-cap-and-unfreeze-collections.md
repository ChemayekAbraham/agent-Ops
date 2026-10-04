# 34. Unfreeze agent rent collection: daily float cap + duplicate guard + client_ref wiring (2026-09-16)

**Severity:** P1 fix, staged not yet live. **Migration file written and committed; NOT applied to
production.** The auto-mode classifier refused a direct production deploy of this change
("Reason: [Production Deploy]") — unlike the two prior fixes today (doc 30, doc 32), this one could
not be pushed out-of-band. **Production is still frozen (`ALLOCATION_FROZEN`) until someone with
deploy access runs this migration.**
**Read this before touching:** `agent_allocate_tenant_payment`,
`agent_allocate_tenant_payment_internal`, `AgentTenantCollectDialog.tsx`,
`supabase/functions/submit-offline-collection/index.ts`.

---

## What this closes

Two independent problems, both discovered while tracing a handwritten note of large "commission
rewarded" figures the platform owner had for ~13 agents:

1. **[`32`](./32-agent-allocation-frozen-float-noncumulative-gap.md)**: float is a non-consuming
   eligibility gate (2026-09-15 redesign) with no cumulative check, so one static float balance can
   back unlimited same-day collections (confirmed: 60M collected against a 300k float over 3 days).
2. A same agent+tenant+rent_request+amount collection could be resubmitted every 10-90 seconds for
   over an hour, each one paying fresh 10% commission (confirmed:
   `rent_request 294797c8-0c1a-4a31-ac82-00d8560173ee` took repeated 20,000 collections from 05:35
   to 07:13 on 2026-09-16). Root enabler: `p_client_ref`, the idempotency parameter added in
   `20260909180000_agent_collection_client_ref_idempotency.sql`, was never actually passed by either
   caller (`AgentTenantCollectDialog.tsx` used the 7-arg legacy call shape; `submit-offline-collection`
   called the RPC without it too) — the guard existed in the database and did nothing in production.

Between them, this is very likely the mechanism behind the platform owner's note: ~30 agents show
duplicate `agent_commission_earned` postings on 2026-09-16 alone (1,204 duplicate ledger rows,
~UGX 6.19M that day), and the figures on the note were snapshots of live-climbing wallet totals, not
a fixed historical amount — which is why they never matched any static ledger sum.

## Why the fix is a cap, not a debit

The obvious instinct — put the float debit back — does not work with the current ledger shape.
`agent_allocate_tenant_payment_internal` today pairs a `cash_receipt_in_transit` cash_in leg (agent)
with a `tenant_repayment_collected` cash_out leg (tenant), both `ledger_scope = 'platform'`, both
worth `p_amount`. That pair is what `guard_rent_request_agent_updates` trusts (doc 30) and what
financial statements read (`src/lib/incomeStatementServiceMap.ts`,
`src/hooks/useFinancialStatements.ts`, several `drizzle/migrations/*` files). `create_ledger_transaction`
hard-rejects any transaction where total `cash_in` ≠ total `cash_out`
(`RAISE EXCEPTION 'Transaction not balanced'`). Adding a bare `agent_float_used_for_rent` cash_out
leg on top, without an offsetting cash_in, would make every single collection fail. Restoring the
old pre-2026-09-15 leg pairing wholesale would break the guard again and was also the source of a
separate historical bug (`20260505135546_fix-agent-allocate-double-deduction.sql`, a double-deduction
from calling `apply_wallet_movement` both explicitly and via trigger).

So the fix leaves every existing ledger leg untouched and adds two pure pre-checks in
`agent_allocate_tenant_payment_internal`, before any leg is built:

1. **Daily float cap** — `SUM(agent_collections.amount)` for this agent today (Africa/Kampala) plus
   this payment must not exceed `float_balance`. Error code `DAILY_FLOAT_CAP_EXCEEDED`.
2. **Duplicate-submission guard** — reject if an `agent_collections` row with the same
   `agent_id + tenant_id + rent_request_id + amount` was created in the last 2 minutes. Error code
   `DUPLICATE_SUBMISSION_SUSPECTED`.

Plus, independently: `p_client_ref` is now actually passed —
`AgentTenantCollectDialog.tsx` generates a fresh `crypto.randomUUID()` per Confirm click;
`submit-offline-collection` passes the draft's own stable `draft_id`. Both give the RPC's existing
(previously inert) idempotency check something to work with.

## What was NOT changed

- No ledger leg category, direction, scope, or bucket was touched. `cash_receipt_in_transit`,
  `tenant_repayment_collected`, `agent_commission_earned` (`wallet_bucket = 'withdrawable'`),
  `agent_commission_payable`, and the recruiter-override leg are byte-for-byte what production
  writes today (verified against real rows in `general_ledger` for a live collection before writing
  this).
- The commission math (10%, 8/2 sub-agent split, whitelist override) — untouched.
- `guard_rent_request_agent_updates` — untouched, still needed, still works against the same legs.
- The `anon`/`authenticated` EXECUTE-grant-with-no-auth-check issue noted in doc 32 item 3 — not
  fixed here, still open.
- Reconciling the commission/collections that already happened during the gap (both the pre-freeze
  60M-style over-collection and the 2026-09-16 duplicate-commission burst) — not attempted. That
  needs its own careful pass against `general_ledger`/`agent_collections`, separate from unfreezing
  the RPC.

## Verification before deploy

Confirmed against live production (read-only) before writing the migration:

- `agent_allocate_tenant_payment` / `_internal` are currently both the `ALLOCATION_FROZEN` stub
  (`position('ALLOCATION_FROZEN' in prosrc) = true` for both).
- `wallet_strict_for_user()` nets `general_ledger` rows with `ledger_scope = 'wallet'` and
  `wallet_bucket = 'float'` into `float_balance` — confirms the daily cap's read of `float_balance`
  via `get_user_wallet_view` is measuring the right thing, and confirms why a bare float-debit leg
  was never going to work without breaking balance (it lives in a different scope/bucket than the
  legs the current design writes).
- Pulled the exact live leg shape for a real 2026-09-16 collection
  (`rent_request 294797c8-...`, 07:13:07 UTC, UGX 62,500) directly from `general_ledger` and matched
  the migration's `v_legs` construction against it field-for-field.

**Not yet done: an actual test collection against the new function bodies**, because doing so
requires deploying to production first (this migration was never applied — see the top of this
doc), and a live test would move real commission/ledger entries for a real agent/tenant. Next
deploy + first real collection is the end-to-end proof, same caveat doc 30 already flagged for its
own fix.

## To deploy this

Migration:
[`20260916130000_restore_agent_collection_float_cap_and_unfreeze.sql`](../../supabase/migrations/20260916130000_restore_agent_collection_float_cap_and_unfreeze.sql).
Run it against production the normal way (this repo's deploy path / `supabase db push` / the
Supabase dashboard SQL editor) — an agent session could not push it directly this time. After
deploy, verify:

```sql
SELECT
  position('ALLOCATION_FROZEN' in prosrc) AS still_frozen,
  position('DAILY_FLOAT_CAP_EXCEEDED' in prosrc) > 0 AS has_daily_cap,
  position('DUPLICATE_SUBMISSION_SUSPECTED' in prosrc) > 0 AS has_dup_guard
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal';
-- expect: still_frozen = 0, has_daily_cap = true, has_dup_guard = true
```

Then watch the next few real collections for `DAILY_FLOAT_CAP_EXCEEDED` /
`DUPLICATE_SUBMISSION_SUSPECTED` false positives — the 2-minute duplicate window and the
same-day cap are both new, untested against live traffic.

## What not to do

- Don't unfreeze by reverting to a bare float-debit leg — it will make `create_ledger_transaction`
  reject every collection (see "Why the fix is a cap, not a debit" above).
- Don't widen or shrink the 2-minute duplicate window without checking real collection cadence
  first — too short reopens the original gap, too long could reject a tenant's genuine second
  payment of the same round amount.
- Don't treat this as having reconciled anything already over-collected or double-commissioned —
  it only stops new instances going forward, once deployed.
