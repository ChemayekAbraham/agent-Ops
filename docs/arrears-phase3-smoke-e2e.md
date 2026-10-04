# Phase 3 — Smoke & End-to-End rehearsal of the rent day-arrears engine

**Date of run:** 9 September 2026 (Africa/Kampala)
**Database:** RentFlow (`welileapp`) production instance
**Data used:** 100% virtual/dummy actors created inside transactions that were **deliberately rolled back**. No production user, plan, wallet, ledger row or collection was read as an input to a test or left behind as an output. Nothing was created for this exercise that still exists.
**Code changes:** none. This document reports behaviour only. Every defect below is reported, not fixed.
**Paths used:** the real production paths only — `agent_allocate_tenant_payment` → `agent_allocate_tenant_payment_internal` → `create_ledger_transaction` → `rent_apply_collections_to_days`, and the real read surfaces `v_rent_day_ledger`, `v_rent_plan_arrears`, `v_rent_collection_unapplied`, `agent_collect_context`, `rent_plan_day_ledger`, `agent_arrears_overview`. No temporary function, stub, or shortcut was created, and no test was made to pass artificially.

---

## Section 1 — What the system says today (baseline)

| Item | Live value |
| --- | --- |
| Arrears go-live floor (`rent_arrears_go_live()`) | **2026-09-10** (tomorrow, relative to the run) |
| Today (Kampala) at run time | 2026-09-09 |
| Daily pin cron | `pin-agent-expected-day-eat-midnight`, `5 21 * * *` UTC = 00:05 EAT |
| Unapplied-money sweeper (`rent_sweep_unapplied_collections`) | exists, **not scheduled** |
| Attribution table | `rent_day_settlements(rent_request_id, day, collection_id, amount)` |
| Collection receipts | `agent_collections` |
| Agent commission | 10% of the amount collected, credited instantly |

**Plan shape used throughout** (the user's example): rent UGX 100,000, 30-day cycle. The live formula trigger produced:

| Field | Value |
| --- | --- |
| `total_repayment` | **UGX 143,000** |
| `daily_repayment` | **UGX 4,767** (4,766.67 rounded up) |
| Pinned expectation per day | UGX 4,767 |

Note the user's assumed daily figure of 4,766.67 is the unrounded value; the system pins **4,767**. This one-shilling rounding is visible in the results below and is the reason a payment of exactly 4,766.67 is recorded as a *partial* payment.

---

## Section 2 — The five payment cases (1–5)

All five ran on separate virtual plans that started 5 days before the run, through the real collection RPC. Because the arrears views ignore days before the go-live floor, each receipt's timestamp was shifted to the go-live day (2026-09-10 09:00 EAT) so the **real** allocator could be observed doing real work; the allocator, the settlement rows and the ledger are all genuine.

| # | Agent collects | RPC result | Expected today | Shortfall | Marked partial | Settled to days | Day remainder | Left unapplied | `amount_repaid` | Plan status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 5,000 | success | 4,767 | 0 | no | 4,767 | 0 | **233** | 5,000 | repaying |
| 2 | 4,766.67 | success | 4,767 | **0.33** | **yes** | 4,766.67 | 0.33 | 0 | 4,766.67 | repaying |
| 3 | 0 (not collected) | no call | 4,767 | — | — | 0 | 4,767 | 0 | 0 | funded |
| 4 | 4,000 | success | 4,767 | **767** | **yes** | 4,000 | 767 | 0 | 4,000 | repaying |
| 5 | 50,000 | success | 4,767 | 0 | no | 4,767 | 0 | **45,233** | 50,000 | repaying |

What happens in words:

1. **5,000** — the day is closed in full and the 233 surplus is *not* lost: it sits as unapplied credit and is available to the next open day.
2. **4,766.67** — one third of a shilling short of the pinned 4,767, so the system stamps a shortfall and flags the collection partial. The day stays open by 0.33.
3. **0** — nothing is written anywhere. There is no "missed" record; the day simply stays open with 4,767 remaining. Absence of payment is inferred from an unsettled pinned day, never from a row.
4. **4,000** — accepted, shortfall 767 recorded on the collection, day left 767 open. Nothing is refused because of a shortfall.
5. **50,000** — the due day is closed and 45,233 remains unapplied. It is not written off and not returned; see Section 4 for what it then covers.

In every successful case the money moved for real: agent float debited, 10% commission credited to the agent, and a platform `tenant_repayment` leg posted.

---

## Section 3 — The nine tenant situations

Run on separate virtual plans, with pins created exactly as the 00:05 cron creates them.

| Situation | Setup | What the system did |
| --- | --- | --- |
| 1. One day behind | start = yesterday | day pinned and open; a later payment closes yesterday first (oldest-open-day first) |
| 2. No day missed | start = today | expected today 4,767; a payment closes today and rolls forward |
| 3. Never paid at all | start = today, no collection | no rows, day open, `days_behind` reported as **0** because the open day is before the floor |
| 4. Never paid for 5 days | start = today − 5 | 12 days pinned, 57,204 expected; **`v_rent_plan_arrears` reported 0** while the same arithmetic without the floor gives **23,835** |
| 5. Brand-new plan just approved | start = today | expected today 4,767 immediately; but see Defect D2 — a plan approved after 00:05 gets **no pin at all** that day |
| 6. Cycle/balance completed | 143,000 collected | plan reaches `completed`; collections beyond the outstanding balance are refused by the internal allocator |
| 7. No arrears | paid up to date | day ledger shows remaining 0, arrears row absent |
| 8. Cycle expired (30-day window passed) | start = today − 35 | expected today **0** (schedule ended); a 50,000 payment was accepted but **100% of it stayed unapplied** — the 143,000 of open days are all before the floor, so nothing could be attributed and no arrears row exists at all |
| 9. Weekly repayment | weekly, start = 8 days ago | 3 instalments pinned at 33,369 each (4,767 × 7); expected today **0** (the corrected weekly rule); a 50,000 payment settled one full weekly instalment (33,369) and left 16,631 unapplied |
| Paid ahead | 50,000 on a current plan | settled **6 consecutive days** (28,602) and left 21,398 unapplied — prepayment works forward correctly |

---

## Section 4 — Paying ahead

Confirmed working. On a current plan a single 50,000 collection produced **six** `rent_day_settlements` rows covering 2026-09-10 → 2026-09-15 (6 × 4,767 = 28,602), with 21,398 still unapplied and available for the days after that. Surplus is never discarded and never double-counted: the allocator matches cumulative collection ranges against cumulative day ranges under a per-plan advisory lock, so re-running it changes nothing.

**Caveat (D4):** the surplus only lands on days that have already been pinned. Days not yet pinned stay uncovered until the cron pins them, and the sweeper that would then apply the credit (`rent_sweep_unapplied_collections`) **is not scheduled**. Until the tenant's next collection, paid-ahead money can sit visible as "unapplied" rather than as days covered.

---

## Section 5 — Money trail per payment (what is written)

A single 5,000 collection wrote, in one transaction:

| Where | Row |
| --- | --- |
| `agent_collections` | receipt: amount, agent, tenant, plan, channel, float before/after, shortfall, expected amount |
| `general_ledger` (wallet) | `agent_float_used_for_rent` cash_out 5,000 — agent float bucket |
| `general_ledger` (wallet) | `agent_commission_earned` cash_in 500 — agent withdrawable bucket |
| `general_ledger` (platform) | `agent_commission_payable` cash_out 500 |
| `general_ledger` (platform) | `tenant_repayment` cash_in 5,000 |
| `rent_requests` | `amount_repaid` advanced, status → `repaying` |
| `rent_day_settlements` | one row per day the money closed |

Verified live: float 300,000 → 283,000 after collections of 5,000 + 5,000 + 7,000, with commission legs 500 / 500 / 700 posted.

---

## Section 6 — Traceability for Agent Ops, Tenant Ops and CFO

No new dashboard component is needed. With a virtual `agent_ops` user signed in, the read surfaces answered correctly under RLS:

| Surface | Answer |
| --- | --- |
| `rent_plan_day_ledger(plan)` | returned the plan's day-by-day expected / settled / remaining |
| `agent_arrears_overview(agent)` | returned the agent's plans with arrears and oldest open day |
| `agent_collections` | every receipt, with collector, time, amount, shortfall |
| `general_ledger` | every leg above, joined by `source_table = 'agent_collections'` and `source_id` |
| `rent_day_settlements` | exact attribution of each shilling to each day |

CFO/Financial Ops, Tenant Ops, Landlord Ops and Partner Ops share the same authorisation branch as Agent Ops in these functions, so the same reads are available to them. Agents see only their own, assigned or sub-agent plans.

---

## Section 7 — Defects and gaps found (nothing was fixed)

| ID | Severity | Finding |
| --- | --- | --- |
| **D1** | High | **The go-live floor hides real arrears.** Every arrears read is floored at 2026-09-10. A plan five days in default reported arrears **0** where the same arithmetic without the floor gives **23,835**. On 2026-09-09 the engine is effectively blind: no plan can show a behind day, and `agent_collect_context` returns `days_behind: 0` for a tenant who has never paid. |
| **D2** | High | **`pin_agent_expected_day` skips the whole day if any pin exists.** It returns 0 when *one* row is already present for that date, so every plan approved after 00:05 EAT is left unpinned for its first day, and any plan missed by the first run is never caught up. Confirmed in the live function body. |
| **D3** | High | **An expired cycle silently swallows money.** On a plan whose 30-day window closed, expected today is 0, `v_rent_plan_arrears` has **no row at all**, and a 50,000 payment was accepted with **100% left unapplied** — 143,000 of open days existed but all sat below the floor. Overdue plans past their window are invisible to the arrears queue while still taking payments. |
| **D4** | Medium | **The sweeper is not scheduled.** `rent_sweep_unapplied_collections()` exists but no cron runs it, so prepaid credit is only applied on the next collection for that plan. |
| **D5** | Medium | **Repeat collections inside one database transaction lose the plan balance.** Three real collections (5,000 + 5,000 + 7,000) produced three receipts, three float debits and three commission credits — total 17,000 — while `rent_requests.amount_repaid` stayed at **5,000**. Cause: `guard_rent_request_agent_updates` compares the balance delta to float debits *in the current transaction* (`xmin = txid_current()`), so the second and later increments mismatch and are silently reverted to the old value. The app collects one payment per transaction, so ordinary use is unaffected — but any batch or bulk path that collects twice in one transaction will debit the agent, pay commission, and credit the tenant nothing, with no error raised. |
| **D6** | Low | **Rounding asymmetry.** Days are pinned at 4,767 while the true instalment is 4,766.67, so a mathematically exact payment is recorded as partial with a 0.33 shortfall, and 30 pinned days total 143,010 against a 143,000 balance. |
| **D7** | Low | **A weekly plan's current week is invisible as an obligation.** Expected today is 0 on a weekly plan between due dates (by design, after the weekly correction), and its pre-floor weekly instalments — 66,738 in the rehearsal — do not appear anywhere as arrears. |
| **D8** | Informational | No real in-scope collection has yet exercised the allocator in production, because the floor begins the day after this run. Phase 1 and Phase 2 verification was read-only; this run is the first end-to-end exercise, and it was rolled back. |

---

## Section 8 — What is confirmed working

- Authorisation: the collection RPC enforces a signed-in agent with an agent role and ownership/assignment/sub-agent rights.
- Float gate: a collection cannot exceed the agent's float; float is debited for real.
- Over-collection gate: a payment above the outstanding balance is refused.
- Shortfall stamping: expected amount and shortfall recorded per receipt; partial payments accepted, never blocked.
- Oldest-open-day-first settlement, idempotent under repetition.
- Prepayment across consecutive future days.
- 10% agent commission credited instantly per collection.
- Weekly plans no longer charge a whole week to a single day for eligibility.
- Reversed collections are excluded from unapplied money (Phase 1 behaviour, unchanged).
- Full staff traceability without any new UI.

---

## Section 9 — Honest limits of this rehearsal

- **Time cannot be moved.** The database clock said 2026-09-09 and the arrears floor said 2026-09-10, so no genuinely late day could exist at run time. Behind-day and arrears figures marked "no floor" in Section 3 are the same arithmetic run with the floor removed, clearly labelled as rehearsal, not as engine output.
- **Receipt timestamps were shifted** to the go-live day on virtual receipts so the real allocator had in-scope money to work with. The allocator, settlements and ledger legs are genuine; the timestamps were not.
- **D5's trigger** would not fire this way in the app, which uses one transaction per collection. It is reported because a batch path would hit it.
- Everything ran inside rolled-back transactions, so none of these results can be re-read from the database.

---

## Section 10 — Recommended order of work (not implemented)

1. **D2** first — an unpinned day cannot ever be collected against or shown as behind; every other number depends on the pins being complete. Make the pin idempotent per plan rather than per day, and back-fill on approval.
2. **D1 / D3** — decide the intended treatment of pre-floor and post-window days. Either lower the floor for plans whose term straddles it, or state explicitly that arrears begin at 2026-09-10 and show expired plans in a separate overdue queue so payments are not accepted into a void.
3. **D4** — schedule `rent_sweep_unapplied_collections()` shortly after the 00:05 pin so prepaid credit lands on the newly pinned day the same morning.
4. **D5** — make the guard compare the cumulative float debit for the plan in the transaction, not a single-delta match, or raise instead of silently reverting.
5. **D6** — pin the unrounded instalment and round only the last day, so pinned days total the balance exactly.
6. **D7** — show the running week on a weekly plan as "due by <date>" rather than nothing, so an officer can see the obligation without it being counted as a missed day.
