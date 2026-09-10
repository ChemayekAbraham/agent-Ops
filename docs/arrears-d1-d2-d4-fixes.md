# Arrears defects D1, D2, D4 — the fixes

Follow-up to [arrears-e2e-smalls-ronald-musana.md](./arrears-e2e-smalls-ronald-musana.md).
Written 10 September 2026. **Code complete and verified; the four migrations are not yet applied to production.**

| | Defect | Decision | Status |
| --- | --- | --- | --- |
| **D1** | Receipt says "paid in full" while the tenant is days behind | Fix | ✅ built |
| **D2** | Expired cycle owing everything contributes 0 to expected | Fix — give it a dashboard section | ✅ built |
| **—** | Agent Ops > Performance shows no arrears balance, and mislabels in-term plans | Show arrears beside Expected; keep Expected and the reports as they are | ✅ built |
| **D3** | Lowering the go-live floor sweeps historical payments in | **No backfill** — the feature is new, old data stays out | ✅ closed, no code |
| **D4** | Two collections in one transaction lose the second balance | Fix | ✅ built |
| **D5** | Day one of a plan is never collectable | Show the agent a countdown | ⚠️ see below — the countdown does not exist |

---

## D1 — a receipt must be measured against everything owed

**Was:** `expected = today's pinned instalment` and nothing else.

```sql
v_expected   := agent_expected_collection(plan);          -- TODAY only
v_shortfall  := GREATEST(0, v_expected - amount);
v_is_partial := v_expected > 0 AND amount < v_expected;
```

An agent collecting one full day's money from a tenant five days behind got a receipt stamped **shortfall 0, not partial** — "paid in full" — with 19,068 still owed.

**Now:** `expected_amount` keeps its meaning (today's instalment, so existing reports still sum against the pinned bill) and two new columns record what was actually owed. `shortfall_amount` and `is_partial` are measured against the total.

```
total_due = LEAST(today's instalment + arrears, outstanding)
shortfall = GREATEST(0, total_due - amount)
is_partial = total_due > 0 AND amount < total_due
```

The `LEAST()` cap matters: a tenant can never be recorded as owing more than the plan's outstanding balance.

| Scenario | Paid | Old stamp | New stamp |
| --- | ---: | --- | --- |
| One day behind | 4,767 | 0 short, not partial | **4,767 short, partial** |
| Five days behind | 4,767 | 0 short, not partial | **19,068 short, partial** |
| Expired cycle | 4,767 | 0 short, not partial | **138,233 short, partial** |
| Up to date | 4,767 | 0 short, not partial | 0 short, not partial *(unchanged)* |

**Timing is favourable.** Arrears are **0 right now** — the queue went live today and no day before today is in scope — so this changes **nothing on today's 43 receipts**. It starts telling the truth tomorrow, when today becomes yesterday.

**Partials are still never blocked.** The wrapper only stamps; there is no confirmation gate and no mandatory reason. What changes is that Operations' partial-collection surfaces stop under-counting.

Client side mirrors it: `totalDueNow()`, `isPartialPayment()` and `paymentShortfall()` in `src/lib/arrearsAllocation.ts`, and the collect dialog now judges against total owed instead of today. The partial notice reads *"X owes 19,068 right now"* rather than quoting today's instalment.

**Files:** `supabase/migrations/20260910120000_receipts_measure_against_total_owed.sql`, `src/lib/arrearsAllocation.ts` (+5 tests, 17 passing), `src/components/agent/AgentTenantCollectDialog.tsx`.

---

## D2 — ended Rent Plans that still owe

Once a plan's term passes there are no more days to pin, so `agent_expected_collection()` returns 0 while the tenant may still owe the whole balance. The arrears queue does not carry them either: it is floored at the go-live date and an expired cycle's unpaid days sit almost entirely before it.

**Measured against production today: 472 Rent Plans, 144,897,343 UGX, oldest cycle ended 10 April.**

**Now:** a card on the agent dashboard, **Ended Plans Still Owing**, sitting directly under the arrears card. It renders nothing when the agent has none. Expanded, each row shows the tenant, the end date, how many days ago, the outstanding amount against the plan total, and the date of their last payment (or "never paid").

Deliberately **not** built on the day-settlement queue — an expired cycle's unpaid days sit almost entirely before the go-live floor, so the queue holds none of them. The truthful figure is the balance still owed on the plan. No backfill is performed and none is needed: the balance was always there, it simply had no surface.

### Corrected during review: one definition, not two

The first draft read `rent_requests` directly and reported **508 plans / 153,796,274** — against the **472 / 144,897,343** that Agent Ops > Performance already reports for the same population. Two surfaces, two numbers, no way for anyone to tell which was right.

The ops figure was right. It is built on `v_rent_plan_schedule`, which carries eligibility rules the draft had silently dropped:

| Excluded by `v_rent_plan_schedule` | Why it matters |
| --- | --- |
| An **active repayment pause** | The tenant has been formally granted a hold |
| `tenancy_status <> 'active'` / `tenancy_ended_at` set | They have moved out |
| `agent_payment_status = 'not_paying'` | Already off the collection book |
| status `disbursed`, or `duration_days = 0` | Not yet a live repayment schedule |

**41 plans carrying 10,027,682** were in the draft only — tenants an agent must *not* be told to chase.

The view is now built on `v_rent_plan_schedule` using the identical arithmetic, and the migration carries a post-condition that **fails if the two ever disagree**. Verified: **472 / 144,897,343 on both sides, exactly.**

Authorization is the same three-party test as the rest of the arrears surfaces — ops roles see any agent, an agent sees only themselves. The view itself is not directly readable; access goes through the SECURITY DEFINER function.

**Files:** `supabase/migrations/20260910140000_agent_expired_cycles_still_owing.sql` (view `v_rent_plan_expired_owing` + `agent_expired_cycles()`), `src/hooks/useAgentArrears.ts`, `src/components/agent/AgentExpiredCyclesCard.tsx`, mounted in `AgentActionInsights.tsx`.

---

## Agent Ops > Performance — arrears beside Expected

Expected stays exactly what it is: **4,690,879 across 223 plans today** — only what the agreed payment plans schedule for today. Arrears are never folded into it. Adding them to the denominator is the same trap that once showed 93% coverage where the honest figure was 41.8%.

The **Field collection target today** card already existed and already carried the right discipline ("Separate from Expected", "Never add the two together"). What it could not show was **how much is actually owed** — only the daily instalment rate of tenants in arrears. `arrears_to_date` was being computed and returned by the RPC and then thrown away.

**Now published and displayed, split the same way as the daily rate:**

| | Plans | Owed |
| --- | ---: | ---: |
| Behind, still inside their term | 226 | **52,631,619** |
| Past their agreed end date | 472 | **144,897,343** |
| **Total arrears owed** | **698** | **197,528,962** |

### A mislabel fixed at the same time

`in_term` was answering the wrong question. It meant *"does this plan have a pinned day today?"*, not *"is this plan inside its term?"* — and those came apart the moment weekly plans stopped being billed daily. A weekly tenant on a non-collection day has no pin, so the card filed them under **"past their agreed end date — plan has run out"**.

**16 plans carrying 3,315,790 were inside their term and reported as expired**, 6 of them weekly.

The pin still decides what is *billed* today; it no longer decides whether a plan has *expired*. Two questions, now two flags.

| | Before | After |
| --- | ---: | ---: |
| On schedule | 210 plans / 49,315,829 | **226 / 52,631,619** |
| Past term | 488 plans / 148,213,133 | **472 / 144,897,343** |
| **Expected today** | **4,690,879 / 223 plans** | **4,690,879 / 223 plans** |

Expected does not move — verified before the change and asserted by a post-condition in the migration. No pinned plan falls outside its real term, so the reclassification cannot touch the denominator.

**The reports are untouched.** The comprehensive report and the rent collections report keep the same Expected basis and the same columns. Nothing in `AgentOpsComprehensiveReport` or the rent collections report was edited.

**Files:** `supabase/migrations/20260910150000_collection_target_arrears_and_real_term.sql`, `src/components/executive/agent-ops-v2/AgentCollectionsCommandCenter.tsx`.

---

## D3 — no backfill, as decided

Confirmed and closed with no code. The go-live floor stays at **2026-09-10**.

Worth recording *why* this is not merely a display choice: **19,040 pinned days already exist before the floor**, and they are excluded only because `v_rent_day_ledger` filters `day >= rent_arrears_go_live()`. Lowering that floor would activate every collection after the new date and let the allocator spend it settling old days automatically — which is exactly what contaminated the first T3 test run. If a backfill is ever proposed, that consequence has to be planned for, not discovered.

---

## D4 — two collections in one transaction

The user's reading was that a payment larger than expected should clear missed days and then hold the rest ahead. **That is correct and it already works** — verified in all 45 cells; 50,000 against a five-days-behind plan settles six days (28,602) and holds 21,398 ahead. D4 is a different thing.

D4 is **two separate collections on the same plan inside one database transaction**. `guard_rent_request_agent_updates` decided whether an agent's increase to `amount_repaid` was trusted by **summing** every float leg written for that plan in the current transaction:

```sql
SELECT COALESCE(sum(gl.amount), 0) INTO v_current_tx_float_debit ... ;
v_trusted_allocation := (v_current_tx_float_debit = v_repayment_delta) AND ...
```

One collection per transaction: sum = that collection, test passes. Two collections: sum becomes `a1 + a2` while the delta is only `a2`, the test fails, and the guard **silently reverts** `amount_repaid` to its old value. The float was spent, the receipt was written, the tenant's balance never moved.

**Not reachable from the app today** — PostgREST gives every RPC call its own transaction — but any future batch or bulk-collection path would hit it and lose money quietly rather than failing.

**Three things fixed in the guard:**

1. **Match the collection, not the sum.** A trusted increase now needs a float debit of *exactly that amount* written in this transaction. Two collections each find their own row.
2. **`gl.xmin::text::bigint = txid_current()` was a time bomb.** `xmin` is a 32-bit xid; `txid_current()` is 64-bit (`epoch * 2^32 + xid`). They agree only while the epoch is 0 — it is 0 today. At the first xid wraparound the test could never match again, so every agent collection would stop crediting the tenant *and* start raising `Agents cannot move a rent request from funded to repaying`. Now `pg_current_xact_id()::xid`, comparing like with like. No behaviour change today.
3. **Removed the comment that justified the inversion.** The float test still carried *"the float leg is cash_in because collection INCREASES cash at hand"* — the rationale used to invert the collection path on 10 September at a cost of 6,064,036 in wrongly credited float. The code was corrected the same day; the comment was not. A comment that contradicts the code is how the same mistake gets made twice.

**Still open, deliberately.** The trusted test is satisfied by the *presence* of a matching ledger row, not by consuming a one-shot authorisation, so a caller able to `UPDATE rent_requests` directly could in principle apply the same debit twice in one transaction. That hole is **identical before and after** this change. Closing it means putting a token in `agent_allocate_tenant_payment_internal`, which is deployed outside this repository — and a redeploy without the token would break every collection in the country. Not worth it without a deployment process to hang it on.

**File:** `supabase/migrations/20260910130000_guard_trusted_allocation_per_collection.sql`.

---

## D5 — the countdown does not exist

Checked, and the recollection is not borne out. There is **no countdown anywhere in the agent UI**. Searching the whole frontend for `days_until_start` and `REPAYMENT_NOT_STARTED` returns nothing.

What exists is the **server-side refusal**, added 9 September, which returns a clear message and the numbers to build a countdown from:

```json
{ "error_code": "REPAYMENT_NOT_STARTED",
  "error": "Repayment for this Rent Plan starts on 11 Sep 2026. Collection opens then.",
  "repayment_starts_on": "2026-09-11", "days_until_start": 1 }
```

So the agent is stopped correctly, and told why — but only **after tapping Collect and failing**. Nothing warns them beforehand, and `days_until_start` is discarded.

Building the countdown is a small piece of work and mostly presentational (a badge on the tenant row and a line in the collect dialog, fed by `repayment_starts_on`). Not built here — flagging it rather than assuming.

---

## Verification

| Check | Result |
| --- | --- |
| `npm run guard:all` | ✅ all guards passed |
| `tsc --noEmit` | ✅ clean |
| `vitest src/lib/arrearsAllocation.test.ts` | ✅ **17 passed** (5 new) |
| ESLint on changed files | ✅ no new findings (4 pre-existing `any` errors in the collect dialog, unchanged) |
| D1 patch anchors vs the **live** function | ✅ all 5 match, output valid PL/pgSQL |
| D1 patch anchors vs the **checked-in** function | ✅ all 5 match exactly once |

The D1 migration patches the live definition in place rather than restating it, because `agent_allocate_tenant_payment` is deployed outside this repository — restating it would fight that deployment and could clobber the `p_client_ref` idempotency work. It is a no-op when already patched and **aborts rather than applying a partial patch**. Each anchor is a single line that is byte-identical in both the deployed definition and the checked-in migration, because the two differ in line wrapping around the `UPDATE`.

## Not applied yet

The four migrations are written and verified but **have not been run against production** — direct DDL was refused in this session. They can go the normal route (push, and Lovable applies them), or be applied directly with permission. Until then the fixes live in the repository only: the D2 card will render nothing because its RPC does not exist yet, and the Performance card will show blank arrears lines until `agent_ops_collection_target` publishes them.

## Noticed in passing, not fixed

`p_client_ref` idempotency is deployed and in source control, but **the collect dialog never sends it**. That is why the dialog needs a 45-second stall-recovery path that queries `agent_collections` to work out whether a payment landed. Passing a client-generated UUID would make the replay safe by construction and let that fallback go.
