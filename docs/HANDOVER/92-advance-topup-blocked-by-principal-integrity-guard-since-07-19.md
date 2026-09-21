# 92 — CFO advance top-up has raised `ADVANCE_PRINCIPAL_INFLATION_BLOCKED` on every attempt since 2026-07-19; fixed live 2026-09-21

**Fixed and verified live (via rolled-back transaction tests, not a real top-up). Before touching
`enforce_advance_principal_integrity`, `apply_advance_topup`, or `CFOAdvanceTopupDialog.tsx` again.**

## What was reported

Screenshot: CFO trying to top up agent Ssebunya Kc (Yasin)'s advance from UGX 1,500,000 to
3,000,000 via the "Top up this advance" dialog, reason "FRAUDULANT WORK BY THE AGENT". The dialog
showed `ADVANCE_PRINCIPAL_INFLATION_BLOCKED: principal cannot be increased after creation
(old=1500000, new=3000000)` and refused to submit.

## Root cause: two deliberate features shipped six weeks apart, never reconciled

`enforce_advance_principal_integrity` (migration `20260719090818`) added an anti-fraud trigger on
`agent_advances`: "principal may never increase after creation," full stop, on any `UPDATE OF
principal`. Its own comment states the actual intent: *prevent recorded principal from ever
exceeding the actual UGX disbursed to the agent's wallet.*

`apply_advance_topup`'s CFO-override overload (`p_override_eligibility` param, migration
`20260825052306`) — the one `CFOAdvanceTopupDialog.tsx` calls — legitimately increases principal
by design, and does so correctly: role-gated (cfo/manager/agent_ops/coo/super_admin), a 10+
character reason is mandatory, and it creates a **real matching ledger transaction** in the same
statement (wallet credit to the agent's `withdrawable` bucket + platform `cash_out`), plus an
`audit_logs` row. It does not violate the guard's actual invariant — a top-up backed by a genuine
disbursement is exactly the case the guard should allow — but the trigger has no exception for it
and blocks every attempt unconditionally.

**This has been broken since the day the trigger shipped.** `agent_advance_topups`'s last row
before this fix was 2026-07-13 — six days before the guard went live on 07-19. Every top-up attempt
in the two months since (07-19 → 09-21) has failed with this exact error. Not specific to this
advance or this CFO session — a total, silent feature outage.

## The fix

Neither loosening the guard generally nor granting a standing bypass — both would create a real
hole. Instead: a **transaction-local** flag (`set_config('app.advance_topup_in_progress',
<advance_id>, true)`, `is_local = true`) that `apply_advance_topup`'s override overload sets
immediately before its principal-raising `UPDATE`, naming the exact advance row it's about to
disburse into. The trigger's Rule 1 now reads:

```sql
IF NEW.principal > OLD.principal THEN
  IF current_setting('app.advance_topup_in_progress', true) IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'ADVANCE_PRINCIPAL_INFLATION_BLOCKED: ...';
  END IF;
END IF;
```

Why this is safe:
- `set_config(..., true)` is transaction-scoped — it can't leak to another statement, another
  session, or persist on the row. It resets automatically when the transaction ends.
- It's keyed to the specific advance id, not a blanket "topups always OK" switch — verified live
  that setting it to a *different* id does **not** unblock the real target row (see verification
  below).
- Only `apply_advance_topup`'s override overload sets it, and only right before the same statement
  that performs the matching ledger disbursement — so the guard's real invariant (principal tracks
  actual disbursed cash) is upheld, not weakened.
- A raw client-side `.update()` on `agent_advances.principal` (already supposed to be impossible
  per `scripts/guard-frontend-ledger-writes.mjs`, but defense-in-depth matters here) still gets
  blocked exactly as before — it never sets the flag.

**Deliberately NOT touched:** the 4-arg `apply_advance_topup(uuid,numeric,integer,uuid)` overload
(used by `disburseAgentAdvance.ts`'s `applyAdvanceTopupForRequest`, the agent-initiated
top-up-request flow) creates **no ledger transaction at all** — it only updates
`agent_advances`/`agent_advance_topups`. Unblocking that path here would let principal increase
with zero matching disbursement, which is the actual inflation bug the guard exists to prevent.
That overload stays correctly blocked. It needs a separate fix (add the same wallet-credit +
platform-cash_out ledger pair the override overload already has) before it can be safely
exempted — flagging for whoever picks this up next, not fixed in this pass.

## Verification performed (all rolled back, no real top-up executed)

```sql
-- 1. Flag set for the correct row: UPDATE succeeds
BEGIN;
SELECT set_config('app.advance_topup_in_progress', '<advance_id>', true);
UPDATE agent_advances SET principal = principal + 1 WHERE id = '<advance_id>';
ROLLBACK; -- confirmed: no exception raised

-- 2. No flag: still blocked, exactly as before
BEGIN;
UPDATE agent_advances SET principal = principal + 1 WHERE id = '<advance_id>';
ROLLBACK; -- confirmed: ADVANCE_PRINCIPAL_INFLATION_BLOCKED raised

-- 3. Flag set for a DIFFERENT id: still blocked (not a wildcard bypass)
BEGIN;
SELECT set_config('app.advance_topup_in_progress', '00000000-0000-0000-0000-000000000000', true);
UPDATE agent_advances SET principal = principal + 1 WHERE id = '<advance_id>';
ROLLBACK; -- confirmed: ADVANCE_PRINCIPAL_INFLATION_BLOCKED raised
```

Did not execute a real `apply_advance_topup(..., p_override_eligibility := true)` call against
Ssebunya Kc's advance — that's a real disbursement decision (crediting an agent under a stated
fraud allegation) for the CFO to actually click through in the UI, not something to trigger from
this session on their behalf. The dialog should now succeed when they do.

## What not to do

- Don't relax `enforce_advance_principal_integrity` further, or make the transaction-local flag
  persistent/column-based — that reopens the actual fraud vector the guard exists to stop.
- Don't assume the 4-arg (agent-initiated, request-approval) top-up path is fixed by this — it
  remains blocked, correctly, until it gets its own matching ledger transaction.
- Not baselined in `critical_function_drift_alerts` (neither function is on that watch list) —
  confirmed via `select function_signature from critical_function_baselines where
  function_signature ilike '%advance%'` returning zero rows before this fix.
