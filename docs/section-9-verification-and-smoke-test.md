# Section 9 — what was actually built, and does it work

**Verification report, 25 September 2026.**
Companion to [`rent-plan-new-flow-full-report.md`](./rent-plan-new-flow-full-report.md)
§9 *Risks and what to watch*.

Every figure below was read from production today. Every behavioural test was run
**as a real account against the live database inside a transaction that was then
rolled back** — nothing in this report changed production data. The two defects
it found were fixed, and those fixes are live.

---

## Contents

1. [The account used](#1-the-account-used)
2. [What was built — the complete inventory](#2-what-was-built--the-complete-inventory)
3. [Section 9, risk by risk](#3-section-9-risk-by-risk)
4. [The smoke test](#4-the-smoke-test)
5. [Two defects found and fixed](#5-two-defects-found-and-fixed)
6. [What is still open](#6-what-is-still-open)
7. [Figures in §9 that have moved](#7-figures-in-9-that-have-moved)

---

## 1. The account used

You gave the name **SSNKAALI PIUS** and the email **pexpert46@gmail.com**. Those
two point at different records, so I went with the email.

| | |
|---|---|
| Account | `0b109aad-212a-4fd0-ab03-3d7aee9cf397` |
| Name on file | **PIUSLUBEGA SSENKALI** |
| Profile email | `pexpert46@gmail.com` |
| Login identity | `256701355245@welile.user` (phone `+256701355245`) |
| Last signed in | today, 11:20 EAT |
| Permission grants | 15 |
| Roles | access_admin, agent, agent_ops, coo, **cto**, employee, financial_ops, landlord, **landlord_ops**, manager, operations, partner_ops, supporter, tenant, tenant_ops |
| May reverse landlord float | **yes** — via `landlord_ops` and `cto` |
| May view the float queue | **yes** |

### A name collision worth knowing about

There is a second account whose name is spelled almost exactly as you typed it:

| | Your account | The other one |
|---|---|---|
| Name | PIUSLUBEGA SSENKALI | **SSENKAALI PIUS** |
| Phone | +256701355245 | **+256701355243** |
| Email | pexpert46@gmail.com | `0701355243@noapp.welile.user` |
| Roles | 15, including CTO | agent, landlord, supporter, tenant |
| Ever signed in | yes, today | **never** |

Two digits apart on the phone, a transposed spelling of the same name, never
logged in. This is exactly the shape the Phase 2 duplicate detection was built
to catch on landlords — it is not wired to staff profiles. Flagging it, not
touching it.

**The smoke test ran as your account, not that one.**

### How the impersonation worked

`auth.uid()` reads the `sub` claim from `request.jwt.claims`. Each test block
set that claim to your user id **transaction-locally**, ran the RPCs exactly as
the app would, and ended with a deliberate exception so the whole transaction
rolled back. Every RPC saw `auth.uid() = 0b109aad…` and applied your real roles
and your real permissions. No password was used and none was needed.

---

## 2. What was built — the complete inventory

All 23 object-level checks below were run against production today. **23 / 23
pass.**

### Phase 1 — commission corrections

| Object | Expected | Live |
|---|---|---|
| `trg_pay_listed_rent_posted_bonus` | gone | ✅ gone |
| `trg_pay_listed_landlord_verified_bonus` | gone | ✅ gone |
| `trg_credit_agent_rent_funded_bonus` | gone | ✅ gone |
| `trg_recruiter_override_landlord_verified` | gone | ✅ gone |
| `trg_recruiter_override_lc1_verified` | gone | ✅ gone |
| `trg_recruiter_override_tenant_landlord_funded` | gone | ✅ gone |
| `credit_agent_event_bonus` | 5 events only | ✅ the three retired events are rejected by name |
| `fund-agent-landlord-float` | no flat 5,000 | ✅ removed |
| `credit-landlord-verification-bonus` | retired | ✅ 410 stub, both frontend callers removed |

Constants and the agent-facing page were updated to match, and
`RentRewardChips.tsx` was deleted outright — all three stages it advertised paid
nothing.

### Phase 2 — fuzzy duplicate detection

| Object | Live |
|---|---|
| GIN trigram index on `lc1_chairpersons.name` | ✅ |
| `find_similar_landlords()` | ✅ returns 5 matches for a real landlord name |
| `find_similar_lc1()` | ✅ returns 5 matches for a real LC1 name |
| `useSimilarContacts` hook, wired into the landlord form | ✅ |

Measured when built: the old `find_landlord_duplicate` took **230 ms / 3,199
buffers** on a sequential scan; the replacement runs in **2.7 ms / 135 buffers**
warm.

### Phase 3 — the repaying gate

| Object | Live |
|---|---|
| `start_repaying_on_landlord_paid()` | ✅ |
| `trg_aa_start_repaying_on_landlord_paid` | ✅ (the `aa_` prefix is load-bearing — it must sort before `trg_promote_repaying_from_landlord_payout`, which sets the status but not the date) |
| `trg_promote_repaying_from_landlord_payout` | ✅ still present, now harmless |
| `alert_payout_failed_after_repaying()` | ✅ |
| `rent_plan_transition_notices_pending()` | ✅ |
| `rent-plan-transition-notices` edge function | ✅ cron **41650**, every 10 minutes, active |

**Messages actually sent** since it went live at 11:10 EAT today:

| Message | Sent |
|---|---:|
| A1 — agent, "float is in your wallet" | **7** |
| T1 — tenant welcome, "repayment starts tomorrow" | **1** |
| AP — agent, "landlord paid, here is your 1%" | **1** |

### Phase 4 — the 24-hour recall

| Object | Live |
|---|---|
| `landlord_float_idle_alerts` table | ✅ 42 rows |
| `detect_idle_landlord_float()` | ✅ cron **41658**, every 15 minutes, active |
| `landlord_float_recall_go_live()` | ✅ **Monday 28 Sep 2026, 00:00 Kampala** |
| `reverse_funding_treasury()` | ✅ closes defect D8 |
| `cancel_tenant_and_return_landlord_float()` | ✅ patched: system actor, the NOT NULL column that had silently broken every cancel, and the fee reversal |

### Today's additions

| Object | Live |
|---|---|
| `can_reverse_landlord_float()` | ✅ CFO · Landlord Ops · CTO · Super Admin |
| `can_view_landlord_float_queue()` | ✅ the four, plus CEO, COO, Manager, Operations, FinOps, Agent Ops |
| `landlord_float_idle_queue()` | ✅ read, 5 scopes |
| `landlord_float_idle_action()` | ✅ acknowledge · note · dismiss · recall_now |
| `cfo_decide_allocation_return()` | ✅ now reverses the fee, now uses the shared role gate, now idempotent |
| `recognise_funding_treasury()` | ✅ cycle-aware, so a re-funded plan charges again |
| Landlord Ops → Payouts → **Float Not Paid Out** | ✅ new route + nav |
| Same panel on the CFO dashboard | ✅ |

---

## 3. Section 9, risk by risk

### Risk 1 — item 12, the one that must not be got wrong

> *"Stamping the wrong `repayment_starts_on` writes permanent arrears into a bill
> that is immutable by design."*

**The trigger is correct. Twenty-four plans prove it.**

Of 53 plans that moved to `repaying` today, I sorted them by where their start
date actually came from:

| Origin | Plans | Starts before the landlord was paid |
|---|---:|---:|
| **A — stamped by the new trigger** | **24** | **0** |
| B — legacy `funded + 1`, never re-stamped | 18 | 3 |
| C — neither | 11 | 9 |

Every one of the 24 in group A starts **exactly one day after** the landlord was
paid. Not one is early. That is the item-12 acceptance test passing on live
data.

Groups B and C are **pre-existing**. The trigger only acts on plans still at
`funded`, so plans that were already `repaying` when it shipped were correctly
left alone — which is what "we shall not backfill anything" means in practice.
**12 plans carry a start date earlier than their landlord payment, one of them
by 145 days.** None of them were created by this work.

#### One live case that needs a decision

| | |
|---|---|
| Plan | `bb908335-780f-4e17-b40b-8376ea33c87d` |
| Tenant | **Martin Mugwanya** |
| Funded | 22 Sep |
| Landlord actually paid | 24 Sep |
| Old start date (funded + 1) | 23 Sep |
| **Corrected start date** | **26 Sep** |
| Pins already written for 23, 24, 25 Sep | **3 × 13,967 = UGX 41,901** |
| Repaid so far | 0 |

The trigger moved the date forward correctly. The **three pin rows written under
the old date were not removed**, because nothing is backfilled. So this tenant's
agent will open tomorrow showing **41,901 already behind on a plan that has not
started**. This is the Faizal Kayondo / Hamiss Mutyaba shape, live, today, on one
plan. It is three rows. Say the word and they go.

#### The other half of item 12 — pins on plans that are still `funded`

Item 15 was shipped **additive** rather than as the spec's replacement, because
the straight replacement would have dropped 13 plans worth 685,473 and stranded
them permanently. The consequence is that the old payout-evidence clause still
admits `funded` plans to the nightly pin.

Measured over the last 7 days:

| | |
|---|---:|
| `funded` plans that got pinned | 40 |
| **…whose landlord has never been paid** | **17** |
| **Bill written against them** | **UGX 1,316,711** |

That is 1.3m of rent billed to tenants whose landlord has not received anything.
It is the single largest live consequence of anything in §9. The first nightly
pin under the new view runs at **00:05 tonight** — that is the number to check
tomorrow morning.

### Risk 2 — agent earnings drop immediately

Confirmed removed and holding: **zero** accruals for `rent_funded_landlord_float`,
`rent_request_posted` or `tenant_replacement` since Phase 1 shipped, and
`credit_agent_event_bonus` now rejects all three **by name** rather than silently
paying nothing.

On a 250,000 plan the agent goes from 59,750 to 44,750 and the parent from 8,000
to 2,000. **§9 says "tell agents first". I have no evidence that has happened.**
It is not a code task and it is the only item in §9 nobody can verify from the
database.

### Risk 3 — the `service_center_review` backlog

| | §9 said | Today |
|---|---:|---:|
| Plans in `service_center_review` | 3,795 | **3,804** |
| Plans `repaying` | — | 743 |
| Plans `funded` | 103 | **87** |

The backlog is **5.1× the entire repaying book** and has grown by 9 since the
spec was written. Nothing in Phases 1–4 touches it. §9 was right that it will
dominate any measurement of whether this work helped.

### Risk 4 — 107 failed payouts, 74,700,000

**Unchanged: 107 payouts, UGX 74,700,000.** Not one has moved.

The alarms §9 asked for now exist — `alert_payout_failed_after_repaying` and the
idle detector — and **14 cases are sitting in the escalated bucket worth
4,900,000**, visible on the new screen for the first time. The alarm works; the
backlog behind it has not been worked.

### Risk 5 — two `credit_recruiter_override` functions

**Still two overloads.** Not addressed. The three triggers that called them are
gone, so nothing invokes either one today, but both remain droppable-in-the-wrong-
order traps. `recruiter_override` is also still unmapped in
`ledger_account_map`, so any leg it posted would resolve to A9 and vanish from
reporting. Zero legs have ever carried it.

### Risk 6 — `agent_earnings` is silently failing

**Confirmed, and worse than §9 says.**

| | |
|---|---|
| `currency` column exists | **no** — four writers still send it |
| Rows | 5,551 |
| **Last successful write** | **20 July 2026** |

§9 says "stale since April"; it is actually stale since **20 July** — but that is
still **67 days** of an agent-facing earnings feed that looks live and is not.
Every insert fails and no caller checks the result. The money is safe because it
moves through the ledger; only the feed is dead. **Still undecided: fix the
payloads or retire the table.**

---

## 4. The smoke test

Four blocks, **31 assertions**, all as `pexpert46@gmail.com`, all rolled back.

### Block 1 — identity, reads and input validation

| # | Check | Result |
|---|---|---|
| 1 | `auth.uid()` inside the RPC | `0b109aad-212a-4fd0-ab03-3d7aee9cf397` ✅ |
| 2 | `can_reverse_landlord_float` | **true** ✅ |
| 3 | `can_view_landlord_float_queue` | **true** ✅ |
| 4 | Queue, scope `open` | 1 row ✅ |
| 5 | Queue, scope `backlog` | 27 rows ✅ |
| 6 | Queue, scope `escalated` | 14 rows ✅ |
| 7 | Queue, scope `resolved` | 0 rows ✅ |
| 8 | Queue, scope `all` | 42 rows ✅ |
| 9 | `can_act` in the payload | true ✅ |
| 10 | `go_live` in the payload | 2026-09-28 00:00 EAT ✅ |
| 11 | Invalid scope `everything` | **refused** ✅ |
| 12 | Note of 2 characters | **refused**, with a readable message ✅ |
| 13 | Action `destroy` | **refused** ✅ |
| 14 | `acknowledge` with a real note | success ✅ |
| 15 | Acknowledgement attributed to you | `acknowledged_by = you`, timestamped ✅ |
| 16 | `find_similar_landlords('ROBERT SSENYANGE')` | 5 matches ✅ |
| 17 | `find_similar_lc1('MUKASA JOHN')` | 5 matches ✅ |
| 18 | `credit_agent_event_bonus('rent_request_posted')` | `Unknown event_type` ✅ |
| 19 | `…('rent_funded_landlord_float')` | `Unknown event_type` ✅ |
| 20 | `…('tenant_replacement')` | `Unknown event_type` ✅ |
| 21 | `rent_plan_transition_notices_pending(48)` | 0 across all five lists ✅ |

**On #21 being zero.** Nothing is pending because everything due today has
already been sent, and the 6h/18h nudges are deliberately suppressed for float
funded before go-live. The one live open case predates Monday, so its agent is
correctly not being chased about a deadline that does not yet apply to them.

### Block 2 — the full recall, end to end

Subject: the oldest backlog case, idle since **15 May**.

| | Before | After |
|---|---|---|
| Plan `cfaf5255…` (tenant KIIRYA IVAN) | `funded` | **`cancelled`** |
| Agent's landlord float | 3,000,000 | **2,700,000** |
| Allocation | open | cancelled |
| Alert outcome | `pre_go_live_manual_review` | **`manual_recalled`**, closed, attributed to you |

Ledger: two legs, **300,000 in / 300,000 out — balanced**. The fee reversal
correctly reported `nothing_recognised`: this May plan predates treasury fee
recognition, so there was nothing to unwind and it did not invent one.

### Block 3 — the tenant notice (after the fix in §5)

Re-ran the same recall. **1 T2 message queued**, addressed to KIIRYA on
`+256708393443`. Before the fix: **0**.

### Block 4 — route 2, the agent-requested return

Subject: the pending request for landlord **Nabwire Jackline**, 200,000.

| | Before | After |
|---|---|---|
| Allocation | `return_pending` | **`cancelled`** |
| Agent's landlord float | 200,000 | **0** |

Ledger: **200,000 in / 200,000 out — balanced**. Fee reversal:
`nothing_recognised`, correct for this plan.

### Authorisation, cross-checked

| Caller | Action | Result |
|---|---|---|
| An agent | read the queue | **refused** ✅ |
| An agent | approve a return | **refused**, named message ✅ |
| An `operations` user | read the queue | allowed, `can_act: false` ✅ |
| An `operations` user | `recall_now` | **refused** ✅ |
| An `operations` user | leave a note | allowed ✅ |
| A `landlord_ops` user | `can_act` | **true** ✅ |

---

## 5. Two defects found and fixed

The smoke test earned its keep. Both of these were shipped by me earlier today
and both were caught by running the thing as a real user rather than reasoning
about it.

### D-A — a tenant cancelled by a *person* was told nothing

The T2 cancellation notice was written before the manual "Return the float now"
button existed, and filtered on `outcome = 'auto_recalled'` alone.

So the cron cancels a plan and the tenant is texted *"nothing is owed by you"*.
A human cancels the same plan through the new button and the tenant hears
**nothing at all** — and the tenant is the one person in the chain who most needs
to hear it. **All 27 backlog cases would have gone out silently.**

Fixed: the notice now covers `manual_recalled` too. Proven by block 3 —
**0 messages before, 1 after**.

### D-B — "your rent of UGX 0"

The message quotes `rent_requests.rent_amount`, and **4 of the 42 open cases
carry `rent_amount = 0`** — old plans from before pricing was enforced. Those
tenants would have received *"the Rent Plan for your rent of UGX 0 could not be
completed"*, which is worse than silence.

Fixed: falls back to the allocation amount — the money actually released for
that tenant's rent.

Both live, both in
`supabase/migrations/20260925190000_cancellation_notice_covers_manual_recall.sql`,
applied as anchored patches that fail loudly if the source has drifted.

---

## 6. What is still open

Nothing below was changed. Each is a decision, not a task I can take on my own.

| # | Item | Size | Where it sits |
|---|---|---:|---|
| 1 | **Martin Mugwanya's 3 phantom pin days** | 41,901 | 3 rows; delete or leave |
| 2 | **`funded` plans still being pinned before the landlord is paid** | 17 plans / **1,316,711** | consequence of item 15 being additive; check 00:05 tonight |
| 3 | The 27 pre-go-live backlog cases | **7,990,000**, oldest 15 May | now actionable on the new screen |
| 4 | The 14 escalated failed-payout cases | **4,900,000** | FinOps, not a recall |
| 5 | 107 failed payouts overall | **74,700,000** | unmoved since the spec |
| 6 | 1 genuinely stranded fee receivable | 119,000 | plan `5530b7ce`, `rejected` |
| 7 | `agent_earnings` dead since 20 July | 5,551 rows | fix the payloads or retire the table |
| 8 | Two `credit_recruiter_override` overloads | — | drop one before something calls the wrong one |
| 9 | 4 return requests pointing at plans that no longer exist | 1 still **pending**, 200,000 | approving it returns the float fine but updates no plan |
| 10 | 3,804 plans in `service_center_review` | 5.1× the repaying book | the real throughput problem |
| 11 | Item 16 — pin catch-up lookback 6 → 1 | — | deliberately deferred until late pins hit zero |
| 12 | **Telling agents their earnings dropped** | 15,000/plan | not a code task, and not verifiable from here |
| 13 | The duplicate **SSENKAALI PIUS** staff profile | — | never signed in, two digits off your phone |

---

## 7. Figures in §9 that have moved

§9 was written on 23 September. For anyone reading it cold:

| §9 says | Today | Note |
|---|---|---|
| 103 `funded` plans | **87** | plans have moved on |
| 3,795 in `service_center_review` | **3,804** | grown |
| 107 failed payouts / 74,700,000 | **unchanged** | not one has moved |
| `agent_earnings` "stale since April" | stale since **20 July** | still 67 days dead |
| Two `credit_recruiter_override` functions | **still two** | |
| "Run item 12 read-only over the 103 funded plans before it ships" | **done differently** | it shipped, and 24 live plans confirm it stamps correctly |
| §6: "one blocker — a cron has no `auth.uid()`" | **solved** | transaction-local system actor; the audit row names it |

---

## Method, stated plainly

- Every number was read from production on 25 September 2026 and is re-derivable.
- Every behavioural test ran inside a transaction that ended in a deliberate
  exception, so it rolled back. Production data is unchanged by this report.
- The two fixes in §5 were applied deliberately and separately, and are live.
- No password was used. Impersonation was done by setting the JWT `sub` claim
  transaction-locally, which is how `auth.uid()` resolves inside an RPC.

---

## Terminology

Rent Plan (never "loan"), Supporter (never "lender"), Returns (never "interest"
or "ROI"). All amounts UGX.
