# 32. Agent rent-collection allocation frozen platform-wide: float gate never consumes float (2026-09-16)

**Severity:** P1 — deliberate, requested freeze. **All agents are currently unable to record any
rent collection.** Do not unfreeze without closing the gap described below.
**Read this before touching:** `agent_allocate_tenant_payment`,
`agent_allocate_tenant_payment_internal`, or before assuming "Confirm Payment" works for any agent.

---

## What triggered this

Follow-on from [`30-incident-2026-09-16-collection-guard-vs-float-redesign-drift.md`](./30-incident-2026-09-16-collection-guard-vs-float-redesign-drift.md).
That doc fixed the guard that was hard-blocking/silently-dropping collections after the
2026-09-15 float redesign, but flagged as open work (item 2): *"if the redesign has other
downstream assumptions... they have the same drift risk."* This is that other downstream
assumption breaking.

## Root cause

`agent_allocate_tenant_payment_internal`'s float check is:

```sql
IF v_float_balance < p_amount THEN
  RETURN ... 'error_code', 'INSUFFICIENT_FLOAT' ...
END IF;
```

This is a **per-transaction** gate only. Since the 2026-09-15 redesign, float is never decremented
afterward (`float_before = float_after` is written to `agent_collections` on every row, by design —
see the function's own comment: *"Float is an allowance... no longer consumed as if it were
physical cash"*). There is no cumulative check anywhere that compares a day's (or ever's) total
collections against the agent's float.

**Result: one static float balance can back unlimited collections.** Confirmed live before the
freeze:

- Agent `e05d2e42-3fa4-4fac-beb3-98328163aad9` held a flat **UGX 300,000** float. In a 28-minute
  window on 2026-09-16 (06:20–06:48 UTC) they recorded 10 collections totaling **UGX 1,655,666**
  (5.5× their float) — `float_before`/`float_after` read exactly `300000` on every single row.
  Over the trailing 3 days the same agent recorded **UGX 60,059,171** against that same UGX 300,000
  float (≈200×).
- Several other agents in the same 3-day window showed the same pattern at smaller scale (e.g.
  `ebd985fb-...` UGX 18.9M collected on a 455,000 float; `e9bfa700-...` UGX 13.2M on 290,000).

This is not a rounding or reporting artifact — it's confirmed against raw `agent_collections` rows,
and each of those collections also posted real ledger legs (commission paid, tenant receivable
reduced), so it's real money movement, not just a display bug.

## The freeze (this doc)

At the platform owner's explicit request, both `agent_allocate_tenant_payment` (the public entry
point used by `AgentTenantCollectDialog.tsx` and `submit-offline-collection`) and
`agent_allocate_tenant_payment_internal` were replaced with stub bodies that unconditionally
return:

```json
{"success": false, "error_code": "ALLOCATION_FROZEN", "error": "Rent collection allocation is temporarily paused platform-wide while a float-allowance issue is fixed. No collections can be recorded right now — please try again later."}
```

Both functions were frozen, not just the wrapper, because both are independently
`EXECUTE`-granted to `authenticated` **and `anon`** — freezing only the outer wrapper would not
have stopped a direct RPC call to the internal function. (That grant to `anon`/`authenticated` on
a SECURITY DEFINER function with no internal auth check is itself worth a follow-up look — the
internal function has no `auth.uid()` ownership check at all; it currently trusts the caller
completely. Not fixed here, just noted.)

Applied directly to production (agents needed to be blocked immediately) and committed as
[`20260916100000_freeze_agent_allocate_tenant_payment_float_gap.sql`](../../supabase/migrations/20260916100000_freeze_agent_allocate_tenant_payment_float_gap.sql)
so the repo reflects it. Verified live by calling the RPC with dummy UUIDs and confirming the
`ALLOCATION_FROZEN` response.

## Impact while frozen

- **No agent, anywhere, can record a rent collection** until this is reverted. The Confirm Payment
  dialog will show the frozen-error message returned above instead of a normal success/failure.
  This is expected — it is not the bug from doc 30 recurring.
- Deposits, withdrawals, disbursement, and everything else are unaffected — only this one RPC pair
  was touched.

## What's still open — do not unfreeze until this is decided

1. **A real fix has not been chosen or built yet.** Two candidate directions were surfaced to the
   platform owner but not selected:
   - Restore per-collection float consumption (revert to float being debited as cash on each
     collection, as it was before 2026-09-15) — but that was itself the source of an earlier bug
     (see `20260505135546_fix-agent-allocate-double-deduction.sql`), so a naive revert may
     reintroduce that.
   - Keep float non-consuming but add an explicit cumulative check (e.g. sum of today's
     `agent_collections.amount` for the agent vs. their float balance) so the gate actually bounds
     daily exposure instead of just the size of one transaction.
2. **This freeze does nothing to reconcile the over-collection that already happened** (the 60M/
   300k and similar cases above, and the unrelated 660-collection backfill from doc 30). Both are
   separate, still-open cleanup work.
3. **The `anon`/`authenticated` EXECUTE grant with no internal auth check on
   `agent_allocate_tenant_payment_internal`** is a latent issue independent of the float gap —
   worth its own look before this is all considered closed.

## What not to do

- Don't unfreeze by just reverting this migration without also landing one of the two fixes in
  item 1 above — that puts the platform straight back into the over-collection state this freeze
  exists to stop.
- Don't assume "some agents only collected a little over their float" means the gap is minor — the
  200× case above shows it has no real ceiling.
