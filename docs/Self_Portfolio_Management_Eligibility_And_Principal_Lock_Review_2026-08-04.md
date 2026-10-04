# Partner Self Support — The Closed-Loop Flow
**A single, error-free path for a partner to support a tenant**
Rewritten 2026-08-04 (evening). This version supersedes everything previously in this file,
including Addendum A. It answers three objections raised against the earlier design and then
states one flow, end to end, with no branches that can strand money or a tenant.

---

## 0. The three objections, answered up front

**1. "If you say `landlord_ops` this might not work — landlords are verified differently, and
sometimes the landlord is already verified, so this becomes inaccurate over time."**

Correct, and this kills the earlier recommendation. `rent_requests.landlord_ops_reviewed_at` is
a *pipeline event on one request*. Landlord trust is not an event on a request — it lives on the
landlord and the house:

- `landlords.verified` / `verified_at` / `verification_status` / `verification_source`
- `rent_requests.landlord_verification_method`
- `house_listings.verified` / `verified_at`

A landlord verified last month for house A does not need re-verification to support a tenant in
house B, yet the request-stage gate would force the request through Landlord Ops anyway — and
worse, an *old* `landlord_ops_reviewed_at` stamp keeps asserting freshness long after the
landlord's payout number changed. The stamp drifts both ways: false negatives (already-verified
landlord blocked) and false positives (stale stamp trusted). **We stop gating on pipeline
stamps and gate on entity facts instead** (§2).

**2. "For double funding between the partner and the CFO — can't the partner just fund the
landlord float on behalf of the CFO?"**

Yes, and this is the correct framing. It removes the entire race. The partner is not creating a
parallel funding channel; the partner is **pre-funding the same landlord-float disbursement the
CFO would otherwise fund from company capital**. One disbursement, one ledger group, one
landlord payout — only the *source of capital* differs. There is nothing to reconcile between two
channels because there is only one channel (§3).

**3. "The CFO says they will pay out ~55M, yet those are not verified."**

That number is the `pending` bucket: ~130 raw agent submissions, UGX ~55.5M, oldest ~42 days,
nothing verified. It is a *demand signal*, not a payout commitment. Publishing it as a payout
intention is how partners end up funding tenants who do not exist. The fix is a hard separation
between **pipeline demand** (what agents claim exists) and **fundable supply** (what has passed
entity verification and has a real payout destination). Only the second is ever shown to a
partner or quoted as a payout figure (§2.3).

---

## 1. What the flow must guarantee

Five invariants. Every design decision below exists to satisfy one of them.

| # | Invariant | Failure it prevents |
|---|---|---|
| I1 | A plan visible to a partner has a **verified landlord, verified house, verified tenant identity, and a confirmed payout destination** — as facts, not stamps | Funding a ghost tenant / ghost house / wrong number |
| I2 | A plan can be claimed by **exactly one** capital source, ever — partner **or** company float | Double funding, 2× landlord payout |
| I3 | The amount the partner agreed to is **the amount that moves**, and the amount that moves is **the amount the landlord receives** | Silent re-quote, partial delivery, principal drift |
| I4 | Every state has **exactly one** legal next state and a **timeout that returns capital**, never a dead end | Capital stranded in `reserved` forever; the loop the user wants removed |
| I5 | Every money movement is one **balanced ledger group** with `recipient_type` set, and the landlord payout carries the partner's id | Untraceable capital, wallet bucket leakage |

---

## 2. Eligibility: gate on entity facts, not pipeline stage

### 2.1 The fundability predicate

Fundability is computed, per request, from the state of the **entities** it points at. Pipeline
stage is used for one thing only: proving the request itself is not a raw unreviewed submission.

```sql
-- v_partner_self_fundable_plans (replacement definition)
-- A: the request is real work, not a raw submission
   rr.agent_ops_reviewed_at IS NOT NULL
   AND rr.tenant_ops_reviewed_at IS NOT NULL

-- B: the landlord is verified as an ENTITY (any route, any date)
   AND l.verified = true
   AND l.verification_status = 'verified'

-- C: the house is verified as an ENTITY and is not already occupied
   AND h.verified = true
   AND h.tenant_id IS NULL
   AND h.suspended_tenant_id IS NULL

-- D: there is a live, confirmed payout destination
   AND rr.landlord_verification_method IS NOT NULL
   AND l.momo_number IS NOT NULL

-- E: nobody else owns this plan
   AND rr.funded_at IS NULL
   AND rr.supporter_id IS NULL
   AND rr.self_funding_partner_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM partner_self_plan_claims c
                    WHERE c.rent_request_id = rr.id AND c.status IN ('reserved','placed'))

-- F: sane economics
   AND rr.tenancy_status = 'active'
   AND rr.rent_amount >= 50000
```

**Why this survives time.** Clause B/C/D read the current truth. If a landlord's verification is
revoked, or the house gets a tenant, or the payout number is cleared, the plan **leaves the
marketplace on the next read** — no cron, no backfill, no stale stamp. And an already-verified
landlord's new request becomes fundable the moment Tenant Ops clears it, without a redundant
Landlord Ops pass.

### 2.2 Landlord verification is one column, many routes

Landlords arrive verified through several routes (agent field visit, LC1 chairperson
confirmation, self-registration + document check, Landlord Ops desk review). The flow does not
care which. It cares that **`landlords.verified = true` and `verification_status = 'verified'`
right now**, and it records `verification_source` on the claim so we can audit *how* a given
partner's plan was verified after the fact. If a route later proves unreliable, we can
retroactively find every plan funded through it in one query.

### 2.3 Two numbers, never mixed

| Number | Definition | Who may see it | May it be quoted as a payout? |
|---|---|---|---|
| **Pipeline demand** | all unfunded requests, any stage (~55M today) | internal ops only | **No** |
| **Fundable supply** | rows of `v_partner_self_fundable_plans` | partners, CFO, dashboards | **Yes** |

Rule: no partner-facing surface, CFO commitment, forecast, or email may cite pipeline demand as
capital that will be paid out. The CFO's payout commitment is `sum(funding_amount)` over
fundable supply plus already-claimed plans — nothing else. If fundable supply is thin, the
answer is ops throughput on the backlog, never a looser predicate.

---

## 3. Double funding: the partner funds the landlord float on behalf of the company

### 3.1 One channel, two possible sources

There has only ever been one disbursement that matters: **capital → agent's landlord-float
bucket → landlord payout**. The CFO normally sources that capital from company float. In the
partner flow, the partner sources it. Everything downstream is byte-identical.

```text
                         ┌── source = company float  (CFO decision)
capital source ──────────┤
                         └── source = partner withdrawable (partner booking)
                                     │
                                     ▼
                     agent landlord-float bucket  (single destination)
                                     │
                                     ▼
                       landlord payout (OTP-verified)
                                     │
                                     ▼
                    tenant repays  →  returns accrue to source
```

### 3.2 The exclusivity mechanism

`partner_self_plan_claims` is the single arbiter, with `UNIQUE (rent_request_id) WHERE status IN
('reserved','placed','delivered')`. Consequences:

- A partner claim inserts the row. The plan disappears from fundable supply immediately (clause E).
- The CFO's funding queue reads the **same** exclusion. A plan with a live claim is not offerable
  to company float, and the CFO UI shows `Booked by partner <name>` instead of a Fund button.
- A CFO decision to fund from company float inserts the same row with `source = 'company_float'`.
  So the CFO and the partner compete for one row and the loser sees a clear message, not a
  duplicate payout.

This is the whole anti-double-funding design. No cross-channel reconciliation exists because
there is no second channel.

### 3.3 Reservation, not deduction — but capital is really held

On claim we do **not** move the principal to the landlord yet, and we do **not** leave it
spendable either. We place a **hold** on the partner's withdrawable balance for the booked
amount, through the same pending-hold mechanism withdrawals use. Effects:

- Partner cannot double-spend the same UGX across two bookings.
- The strict withdrawable rule (`get_user_available_balance`) already subtracts pending holds,
  so no new balance math is introduced anywhere.
- If the booking expires or is cancelled, the hold is released — capital never leaves, so
  nothing needs to be refunded.

---

## 4. Amounts: the partner authors the number, and it cannot drift

The earlier design derived the partner's principal from `rent_requests.rent_amount`, which agents
can edit after the fact. That is the drift the user objected to. Replaced by:

1. **The partner authors the amount** at booking (`partner_self_commitments.principal_amount`),
   bounded by `min(fundable_amount, strict withdrawable)`. This is the only number the partner is
   ever shown as "your principal".
2. `principal_amount` is **immutable after `confirmed_at`**, enforced by a BEFORE UPDATE trigger.
3. If an agent re-quotes the rent **upward**, the plan's shortfall is filled by company float or a
   second booking; the first partner's principal is untouched.
4. If an agent re-quotes **downward** below the booked principal, the booking is **cancelled
   automatically**, the hold released, and the plan returns to supply. The partner is notified
   with the reason. We never silently shrink someone's investment.
5. The landlord payout must equal the sum of sourced principals for that plan, checked by
   `verify_ledger_delivery` before the payout leg is allowed to post (I3).

---

## 5. The state machine — five states, no dead ends

```text
                (partner books)                 (agent/CFO places into float)
 [fundable] ─────────────────────▶ reserved ─────────────────────────▶ placed
     ▲                               │  │                                │
     │  hold released                │  │ 30 min timeout                 │ landlord paid + OTP
     │  plan returns to supply       │  ▼                                ▼
     └───────────────────────────  cancelled                         delivered
                                     ▲                                   │
                                     │  down-requote / verification lost │ tenant completes plan
                                     └───────────────────────────────────┤
                                                                         ▼
                                                                     released
                                                          (principal + returns unlocked)
```

| State | Meaning | Only legal exits | Timeout |
|---|---|---|---|
| `reserved` | partner booked; hold placed; no money moved | `placed`, `cancelled` | **30 min** → `cancelled` |
| `placed` | principal posted into the agent's landlord-float bucket | `delivered`, `cancelled` (reversal group) | **48 h** → escalate to FinOps, not auto-cancel |
| `delivered` | landlord paid, OTP verified, tenancy live | `released` | plan term |
| `cancelled` | hold released or principal reversed; plan back in supply | terminal | — |
| `released` | principal + accrued returns back to withdrawable | terminal | — |

Every state either has a timeout that returns capital to the partner, or an owner (FinOps) who is
paged. There is no state in which capital can sit unowned — this is invariant I4, and it is the
answer to "keeping the flow in a loop".

---

## 6. The flow, step by step

**Step 1 — Supply.** `v_partner_self_fundable_plans` is read live in the funder dashboard. Each
card shows tenant first name, district, house reference, monthly rent, the amount still needed,
`verification_source`, and the date the landlord was verified. Nothing unverified ever appears.

**Step 2 — Book.** Partner selects one or more plans, types the amount per plan, confirms. One RPC
per booking, transactional: insert claim (unique index arbitrates), insert commitment with the
typed `principal_amount`, place the hold, emit `partner.self_plan.reserved`, capture a trust
signal. On unique violation the RPC returns `plan_already_claimed` and the UI removes the card.

**Step 3 — Place.** The agent (or Partner Ops) posts the principal into the agent's
**landlord-float** bucket. One balanced ledger group: partner wallet `cash_out`
(`recipient_type = 'user'`) ↔ agent float `cash_in` (`recipient_type = 'operational_wallet'`),
`self_funding_partner_id` stamped on the request, claim → `placed`, hold converted to a real
debit. Because the destination is the same float bucket the CFO would have credited, the
existing rent-collection, commission, and repayment engines need no changes at all.

**Step 4 — Deliver.** Landlord payout runs through the existing OTP-verified landlord-float payout
flow. On success: `verify_ledger_delivery` confirms payout == sourced principal, request moves to
`funded`/`repaying`, claim → `delivered`, partner notified by SMS + email.

**Step 5 — Earn.** Returns accrue monthly at the same rate as managed portfolios, from the
delivery date, on `principal_amount` only. Displayed with daily/weekly equivalents.
**Company, not the partner, absorbs tenant default** — the partner's principal is guaranteed by
Welile, consistent with the self-management policy already in force.

**Step 6 — Release.** At plan completion, principal + unpaid returns post back to the partner's
withdrawable bucket; claim → `released`; the plan exits the loop permanently.

---

## 7. Failure catalogue — every way this can go wrong, and what happens

| Failure | Detection | Automatic response | Partner impact |
|---|---|---|---|
| Two partners book the same plan | unique index | second RPC returns `plan_already_claimed` | card disappears, no money moved |
| CFO funds a plan a partner just booked | same unique index | CFO UI blocked with `Booked by partner` | none |
| Landlord verification revoked after booking | claim revalidation before `placed` | booking cancelled, hold released | notified with reason |
| House gets a tenant after booking | same revalidation | booking cancelled, hold released | notified |
| Agent re-quotes rent up | delivery check | shortfall from company float | principal unchanged |
| Agent re-quotes rent down below principal | delivery check | booking cancelled, hold released | notified |
| Partner books more than strict withdrawable | RPC bound + hold | booking rejected | clear error |
| Placement never happens | 48 h timer | FinOps escalation, principal still traceable in one group | visible `placed` status |
| Landlord payout fails | payout flow | principal returns to partner via reversal group; plan re-enters supply | notified |
| Partner abandons the flow mid-booking | 30 min timer | `cancelled`, hold released | none |

---

## 8. What must be built

| # | Change | Layer |
|---|---|---|
| B1 | Redefine `v_partner_self_fundable_plans` on entity facts (§2.1); drop the `coo_reviewed_at` predicate | DB view |
| B2 | `UNIQUE (rent_request_id) WHERE status IN ('reserved','placed','delivered')` on `partner_self_plan_claims`; add `source` (`partner` \| `company_float`) and `verification_source` | DB |
| B3 | CFO / Partner Ops funding queues read the same claim exclusion and render `Booked by partner` | UI + query |
| B4 | Booking RPC: claim + commitment + hold + event + trust signal, one transaction; partner-authored `principal_amount` | RPC |
| B5 | Immutability trigger on `principal_amount` after `confirmed_at` | DB trigger |
| B6 | 30-min `reserved` sweeper and 48-h `placed` escalation cron | cron |
| B7 | Placement posts one balanced group into the agent landlord-float bucket with `recipient_type` set | RPC / edge fn |
| B8 | `verify_ledger_delivery` assertion: landlord payout == sum of sourced principals | DB fn |
| B9 | Revalidate landlord/house/payout facts at `placed`; auto-cancel on loss | RPC |
| B10 | Ban pipeline-demand figures from partner-facing and CFO-payout surfaces; label fundable supply explicitly | UI + reports |

Order: B1 → B2 → B3 (stops double funding and unverified exposure immediately), then B4–B6
(booking correctness), then B7–B9 (delivery correctness), then B10 (reporting hygiene).

---

## 9. Honest reservations

- **Thin supply.** The entity-fact predicate will yield a modest shelf on day one. That is the
  honest number. Filling it is an Agent Ops backlog problem — ~130 pending submissions averaging
  5.5 days — and must not be solved by weakening §2.1.
- **Holds are visible.** A booked partner's withdrawable drops immediately. This is correct but
  must be labelled in the UI as *Booked, awaiting placement*, or it will be reported as a
  missing-balance bug.
- **Placement depends on a human.** Step 3 needs an agent or Partner Ops action. The 48-h
  escalation contains the risk but does not remove it; if placement latency proves bad, make
  placement automatic on booking for agents above a trust threshold.
- **Guarantee is a company liability.** Welile absorbing tenant default is a real balance-sheet
  cost. It should be capped by total self-managed exposure and monitored by the CFO.

---

*This document defines the intended flow only. No code, schema, or data was changed in producing it.*
