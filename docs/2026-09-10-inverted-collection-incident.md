# Inverted collection incident — 10 September 2026

**Window:** 07:29:39 → 09:21:56 EAT · **Closed:** 09:22 EAT · **Reversed:** 10:0x EAT
**Exposure:** 6,064,036 float wrongly credited + 606,403.60 commission = **6,670,439.60**
**Recovered:** 6,487,104.80 · **Written off:** 183,334.80

---

## 1. What happened

At **07:29:39** the collection RPC began doing the exact opposite of its job. Instead of the agent spending their float to settle a tenant's rent, **the platform credited the agent's float** — and still paid 10% commission and still cleared the tenant's debt.

Katongole James was right: he did not pay those tenants. The system paid him.

| Leg | Correct | What it became |
| --- | --- | --- |
| `agent_float_used_for_rent` (agent wallet, float bucket) | `cash_out` | **`cash_in`** |
| tenant platform leg | `cash_in` | **`cash_out`** |
| Receipt `float_after` column | `balance − amount` | **`balance + amount`** |
| `guard_rent_request_agent_updates` trust test | expects `cash_out` | **expected `cash_in`** |

Both sides of the double entry were reversed, the receipt's audit column was reversed to match, **and the guard that is supposed to catch untrusted repayments was changed to expect the inverted direction** — which is why nothing blocked it.

It is visible on the receipts. Katongole's float rose with every collection:

| Time | Amount | Float before → after |
| --- | ---: | --- |
| 07:29:39 | 58,700 | 178,700 → **237,400** |
| 07:33:55 | 1,000,000 | 1,276,068 → **2,276,068** |
| 07:35:33 | 2,000,000 | 2,276,068 → **4,276,068** |

### Verifying Katongole's account of it

He topped up **178,700** of float at 07:26 — almost exactly his real obligation for the day, **178,668** (two daily tenants at 89,334 each). He then recorded collections and watched his float *increase*. The escalating amounts — 58,700, 60,000, 200,000, 600,000, 1,000,000, 2,000,000 — are consistent with someone re-trying against a screen that was plainly wrong. **His "about 17,700" matches his intended day's collection.** He collected nothing legitimately today.

### Cause

New overloads carrying a `p_client_ref` parameter replaced the previous 5-argument functions:

- `agent_allocate_tenant_payment(… , p_client_ref uuid)` — 8 args
- `agent_allocate_tenant_payment_internal(… , p_client_ref uuid)` — 6 args

**No migration for this exists in the repository.** `p_client_ref` appears in none of the checked-in migrations, including the 24 commits pulled this morning. It was applied directly to production. That is the process failure underneath the money failure: a money-path RPC *and* its guard were replaced with no reviewed migration.

---

## 2. Scope — 16 collections, not 17

My first count was wrong and I corrected it. The receipt's `float_before`/`float_after` columns are **not** a safe detector, because the column arithmetic was fixed a few minutes after the ledger direction. Saka's 09:22:34 collection (106,668) looked inverted by that test but its ledger leg was already `cash_out` — it is genuine and was left alone.

The authoritative test is the ledger leg direction.

| Agent | Inverted rows | Float wrongly credited | Commission |
| --- | ---: | ---: | ---: |
| Katongole James | 10 | 5,897,368 | 589,736.80 |
| Saka Homi Melvin | 5 | 93,668 | 9,366.80 |
| Akandwanaho Wycliffe | 1 | 73,000 | 7,300.00 |
| **Total** | **16** | **6,064,036** | **606,403.60** |

Affected tenants: twesige agnes, Namakula Saidat, Kalule Brian, Isabirye Alex, Nabayunga Fausta, Lumala Isaac.

---

## 3. The patch — four fixes, all live

1. **Agent float leg** → `cash_out`
2. **Tenant leg** → `cash_in`
3. **Receipt `float_after`** → `GREATEST(0, balance − amount)` (3 occurrences)
4. **`guard_rent_request_agent_updates`** → expects `cash_out` again

Each was applied by string-replacing the live definition with an abort if the expected pattern was not found, so nothing else in the functions changed — the `p_client_ref` idempotency work is intact.

**Sequencing note, honestly recorded:** fixing the RPC first left it out of step with the guard, which briefly broke collections (`Agents cannot move a rent request from funded to repaying`). I caught that on the verification run and fixed the guard immediately.

### Verified end to end

A real collection through the live RPC, inside a rolled-back transaction:

| Check | Result |
| --- | --- |
| Wallet movement | **−5,000** (correct direction) |
| Receipt float | 500,000 → **495,000** |
| `agent_float_used_for_rent` | **cash_out** / wallet / float |
| `tenant_repayment_collected` | **cash_in** / platform |
| Tenant credited | 5,000 |
| Guard | passed |

Two live collections after the patch (09:22:34, 09:35:11) posted `cash_out` correctly.

---

## 4. The reversal

Posted as **system corrections**, not agent activity: category `system_balance_correction`, which the database auto-classifies as `admin_correction`, with an explicit `solvency_bypass_reason` of `other_with_note` (the description names the incident on every leg). The unrecoverable portion is `platform_loss_writeoff` with reason `write_off`.

**No wallet was driven negative.** Where an agent no longer held the money, the platform absorbed it rather than pushing the agent into debt.

| Agent | Float clawed back | Commission clawed back | Written off | Float after | Withdrawable after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Katongole James | 5,897,368 | 589,736.80 | 0 | **178,700** | 10,278,711.50 |
| Akandwanaho Wycliffe | 0 | 0 | 80,300 | 0 | −679,212 |
| Saka Homi Melvin | 0 | 0 | 103,034.80 | 0 | −1,109,284.12 |
| **Total** | **5,897,368** | **589,736.80** | **183,334.80** | | |

Katongole is back to exactly his 178,700 top-up — the money he actually put in.

Wycliffe and Saka were **already negative on withdrawable before this incident** (−694,012 and −1,109,284 respectively) and had spent the credited float. Clawing back would have deepened a pre-existing deficit, so per instruction the platform absorbed **183,334.80**. Neither was made worse.

### Tenant balances restored

All six back to their pre-incident position, and every plan back to `repaying`:

| Tenant | Repaid | Outstanding | Status |
| --- | ---: | ---: | --- |
| twesige agnes | 60,777 | 2,619,223 | repaying |
| Namakula Saidat | 70,000 | 2,610,000 | repaying |
| Kalule Brian | 47,223 | 1,700,000 | repaying |
| Lumala Isaac | 5,000 | 680,000 | repaying |
| Nabayunga Fausta | 250,000 | 169,000 | repaying |
| Isabirye Alex | 479,000 | 73,000 | repaying |

Isabirye Alex's plan had been flipped to `completed` by the bad collection; it was explicitly returned to `repaying`, since a plan cannot be complete while 73,000 is owed.

All 16 receipts are annotated `[REVERSED: system correction - inverted ledger direction 2026-09-10]`.

> **Correction, 2026-09-10 13:40 EAT.** This section originally continued *"so every tile that sums collections now excludes them"*. **That was wrong and was never checked.** Of the 97 database functions that read `agent_collections`, exactly **two** looked for that substring. The other 95 kept counting the reversed money, so Agent Ops > Overview showed Total Collected 7.19M against a real 1,203,462, listed Katongole as the top performer on 5.90M he never collected, and reported Pending Collections as 0 — hiding a genuine 3,495,377 shortfall.
>
> The reversal itself held throughout: no money moved twice, and Katongole's float is 178,700, exactly his real top-up. This was a reporting failure, not a ledger one — but it granted him **353,842.08 of extra borrowing limit** that has not been reversed (see below).
>
> Fixed by `20260910160000_reversed_collections_are_not_collections.sql`, which promotes the marker to a real `reversed_at` column. A substring in a free-text field is not a data model: nothing forced a reader to honour it, and nothing failed when they did not.

---

## 5. The real collections for today

| | |
| --- | ---: |
| Genuine collections | **9** |
| Genuine cash collected | **323,562** |
| Pinned bill for today | 4,700,079 |
| Attributed to today's days | 27,934 |
| Held ahead (pre-payment) | 295,628 |

**27,934 + 295,628 = 323,562** — the arrears engine reconciles exactly to the cash.

---

## 6. The arrears engine came through it clean

Today was its first live day (go-live 2026-09-10, both crons ran at 00:05 and 00:10).

- It attributed only **178,668** of Katongole's 5.9M to real days and parked the rest as unapplied — it never treated phantom money as performance.
- Marking the 16 receipts reversed **automatically released their day settlements** through the Phase 1 reversal trigger. Verified: **0 settlements remain from reversed collections**.
- Arrears are 0, which is correct — no day before today is in scope and today is not yet late.

**No backfill was performed and none is needed.** The queue starts at 2026-09-10 as agreed, and the incident left no residue in it.

---

## 7. Still open

1. **Redeployment risk.** The inverted version has no migration, so whoever deployed it can redeploy it. `20260910100000_fix_inverted_collection_ledger_direction.sql` re-applies the fix idempotently as a defence, but the real fix is that money-path functions must not be deployed outside a reviewed migration.
2. **183,334.80 written off** — needs a CFO decision on whether to pursue it as agent debt.
3. **Two agents carry pre-existing negative withdrawable balances** (−679,212 and −1,109,284) unrelated to this incident. Worth a separate look.
4. Saka Homi Melvin **withdrew 13,043 at 09:32**, after receiving wrongful commission. Small, but it left the building.
5. The **uncapped `raw_today_pct`** gate loophole from the earlier report is unchanged: a large pre-payment still reads as thousands of percent and unlocks posting.
6. **Credit limits were inflated by the phantom collections and have not been corrected.** `recalculate_credit_limit` raises an agent's borrowing limit by 6% of each collection, and it fired on every inverted one. Katongole's limit rose in ten steps between 07:29:39 and 07:37:30 EAT, from 792,853.52 to 1,146,695.60 — **+353,842.08, exactly 6% of the 5,897,368 he never collected**. Exposure across the three agents holding reversed rows is about **377,462**:

   | Agent | Reversed | Inflation at 6% | Seen in the change log |
   | --- | ---: | ---: | --- |
   | Katongole James | 5,897,368 | **353,842.08** | 353,842.08 — exact match |
   | Akampurira Onesmus | 300,000 | 18,000.00 | not in that window |
   | Saka Homi Melvin | 93,668 | 5,620.08 | 12,020.16, incl. genuine collections |

   Correcting a live limit changes what an agent can draw, so it needs an explicit decision rather than a silent adjustment.
7. **93 functions still count reversed collections.** Three were fixed (`get_agent_ops_overview`, `get_agent_collections_command_center`, `get_agent_collections_coverage`). The ones that matter most among the rest all size money: `recalculate_credit_limit`, `get_agent_advance_potential`, `get_agent_advance_potential_for`, `get_agent_advance_limits`, `get_agent_advance_repayment_monitor`, `recompute_agent_earned_vouch`. On lifetime figures the distortion is large — Katongole's collections read 12,478,260 but are truly **6,580,892**, so **47% of his apparent record is phantom**.
