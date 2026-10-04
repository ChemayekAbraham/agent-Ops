# Partner Self Portfolio Management — Final Decision: Where the Pool Goes
**Decision date: 2026-08-04. Scope: this document answers one question only — the destination of
partner self-managed capital — and the three consequences that follow from it (tenant exposure,
principal recording, OTP timing). It changes no code, schema, or data.**

---

## 1. The decision

**Partner self-managed capital goes into the company landlord-float pool, not into an individual
agent's `agent_landlord_float`.**

The partner funds the *pool* the CFO already funds. The pool then disburses to agent landlord
float per tenant, through the existing CFO disbursement path, exactly as it does today for
company capital. The partner's money never has an agent's name on it.

```text
partner withdrawable
        │  deploy capital (one balanced group)
        ▼
COMPANY LANDLORD-FLOAT POOL  ◀── CFO company capital (same pool, same ledger scope)
        │  existing CFO per-tenant disbursement (unchanged)
        ▼
agent_landlord_float  (per agent, per tenant allocation)
        │  existing OTP-verified landlord payout (unchanged)
        ▼
landlord paid → tenant repays → returns accrue to the capital source
```

---

## 2. Why the company pool has more leverage — the actual reasons

This is the part that decides the design, so it is stated in full rather than asserted.

**2.1 Fungibility.** Capital in the pool can be applied to *any* eligible tenant. Capital dropped
into `agent_landlord_float` can only ever pay landlords reachable by that one agent. The moment a
booked tenant is cancelled, re-quoted, or replaced, pooled capital re-deploys with no ledger
movement at all; agent-float capital has to be reversed out of one agent's bucket and posted into
another's — a reversal group per failure, and every reversal is a chance to corrupt a bucket.

**2.2 No idle capital, no per-agent overhang.** Agent float is sized to what one agent can pay out
this week. Push a partner's UGX 5M into it and most of it sits idle inside an operational bucket
that the daily-eligibility, commission, advance-recovery and sweep engines all read. Idle capital
inside an operational bucket is not neutral: it inflates the agent's apparent capacity, distorts
targets, and is exactly the shape of balance that historical error-correction sweeps have eaten
(Priscilla Namatovu, Tugabirwe Apophia). The pool is not an operational bucket and no sweep,
advance recovery, or commission rule touches it.

**2.3 Exclusivity stops being load-bearing.** Under an agent-float design, the partner's principal
is physically attached to one `rent_request`, so the whole anti-double-funding apparatus — unique
claim index, CFO queue exclusion, revalidation at placement, 48-hour placement escalation — is
mandatory, and every one of those is a place the flow can dead-end. Under the pool design the
principal is attached to the *pool*, and the selected tenants are an **allocation intent**, not a
custody claim. Two partners can fund the same pool while the pool serves the same tenant list;
there is no race to arbitrate because nobody owns a row.

**2.4 One reconciliation point.** The pool has one balance, one ledger scope, one owner (CFO).
Agent float has one balance per agent and is already the noisiest surface we operate — allocation
drift, commission source drift, cache/ledger drift. Placing investor principal there means every
agent-float drift incident becomes an *investor* incident. Placing it in the pool means partner
capital is reconciled by the same CFO controls that already reconcile company capital.

**2.5 Leverage in the literal sense.** The pool is the funding constraint on the whole rent book.
Every shilling in the pool converts to disbursable rent capital immediately and can be matched to
whichever verified tenant clears next. Capital in an agent's float has already spent its
optionality. Same shilling, strictly more usable in the pool. That is the leverage.

**2.6 Where agent float still wins — and why we still reject it.** Agent float gives the partner a
visibly specific tenant and an unambiguous 1:1 story ("my money paid this landlord"). That story
is worth something in a partner relationship. We keep the story by *reporting* the allocation
(selected tenants, districts, houses, expected returns) while *holding* the capital in the pool.
The narrative does not require the custody.

---

## 3. Consequence 1 — Tenant exposure moves earlier, to Tenant Ops clearance

**Decision: eligible-to-display = passed Tenant Operations verification. We no longer wait for
`funded` status.** Confirmed, and this is only safe *because* of the pool decision.

- Displaying `funded` tenants was never a shelf — a funded tenant needs no funding.
- The display list is now an **allocation menu**, not an inventory of claimable units. A partner
  selecting five tenants is telling us what their capital is *for*; it is not a lien.
- Minimum facts to appear on the menu (unchanged from the eligibility review, §2.1 of that doc):
  request cleared Agent Ops and Tenant Ops, landlord verified as an entity right now, house
  verified and unoccupied, live payout destination, sane rent economics.
- Because selection is intent rather than custody, a tenant leaving the menu after selection is a
  **re-allocation**, not a cancellation: the partner keeps their principal and returns, and the
  system swaps in the next eligible tenant. No hold to release, no reversal to post, no partner
  notification about someone else's failed request.

The two-numbers rule survives unchanged: pipeline demand (~55M of raw submissions) is never shown
to a partner and never quoted as a payout commitment. The menu is fundable supply only.

---

## 4. Consequence 2 — Principal is recorded in the investment tables at pool deposit

**Yes, and this is the correct trigger point.**

- On deploy, one balanced ledger group: partner wallet `cash_out` (`recipient_type = 'user'`) ↔
  landlord-float pool `cash_in` (`recipient_type = 'operational_wallet'`).
- The same transaction writes the portfolio/commitment record carrying `principal_amount`, the
  selected tenant allocation, and the return rate. This is what makes the deposit an *investment*
  rather than a transfer, and it is what the ROI engine reads.
- **The principal rule stands, and the pool makes it stronger.** Principal is never reduced by
  tenant outcomes. Returns are the only variable. Under agent-float custody, a failed tenant put
  the principal physically at the wrong place and required a reversal to protect it; under the
  pool, the principal never moved anywhere that a tenant outcome can reach. Company absorbs tenant
  default, as already policy for self-managed funding.
- Expected returns and every projection are computed *from the selected tenant set* (rent amounts,
  daily repayment, plan length) but are **paid on `principal_amount`** at the standard rate. The
  tenant set drives the forecast and the reporting; it does not drive the entitlement.
- `principal_amount` remains immutable after confirmation. Agent re-quotes to rent do not touch it
  — a downward re-quote now triggers re-allocation, not cancellation.

---

## 5. Consequence 3 — OTP: do we wait?

**No. Partner deployment and return accrual do not wait for any OTP. OTP stays exactly where it is
and keeps exactly the meaning it has.**

- The OTP is a **landlord payout control**: it proves the person receiving cash on that MoMo number
  is the verified landlord. It is a control on the *last mile*, downstream of the pool, executed by
  the agent, per landlord, per payout.
- Under the pool design the partner is not the counterparty to that payout — the company is. So
  making the partner's deployment or accrual conditional on it would couple an investor's clock to
  an unrelated field event, and re-introduce the dead-end states the pool design just removed
  (capital reserved, waiting on a landlord who does not answer their phone).
- Timing that is now fixed:
  - **Deployment / principal recorded:** at pool deposit.
  - **Return accrual starts:** deployment date.
  - **OTP:** at landlord payout, unchanged, still mandatory, still blocking *that payout only*.
  - **Failed or refused OTP:** the disbursement to that agent/landlord is reversed inside company
    operations and the tenant is re-allocated. Zero partner-side effect, no partner notification.
- What we do owe the partner is transparency, not a gate: report per-selected-tenant delivery state
  (allocated → disbursed to agent float → landlord paid/OTP verified) so the partner can see the
  field progress of their allocation without their money being hostage to it.

---

## 6. Decision summary

| Question | Decision |
|---|---|
| Where does partner capital land? | **Company landlord-float pool** |
| Does it ever sit in `agent_landlord_float`? | Only after the ordinary CFO per-tenant disbursement, as company capital |
| When is a tenant shown to a partner? | On **Tenant Ops clearance** + live entity verification, not `funded` |
| What does selecting tenants mean? | **Allocation intent** for forecasting and reporting — not custody, not a lien |
| Where is principal recorded? | Investment/portfolio tables, in the **same transaction as the pool deposit** |
| Can tenant outcomes reduce principal? | **No.** Returns vary; principal does not. Company absorbs default |
| Does deployment or accrual wait for OTP? | **No.** OTP gates the landlord payout only |
| What happens when a selected tenant fails? | **Re-allocation** to the next eligible tenant; no reversal, no partner impact |

---

## 7. Honest risks of this decision

- **Traceability is reported, not physical.** "Which shilling paid which landlord" becomes an
  allocation report rather than a ledger fact. If a regulator or a partner demands physical
  earmarking, this decision must be revisited — the pool cannot provide it.
- **Pool discipline becomes critical.** Partner principal now shares a balance with company
  capital. The pool must never be drawn below total live partner principal, and that floor needs a
  CFO control and an alert, or we are lending investor principal to operations.
- **Accrual starts before delivery.** Returns run from deployment while field delivery may lag.
  That cost is real and belongs to the company; it is also the price of removing every dead-end
  state from the flow, and it puts the incentive to disburse fast on the right party (us).
- **Menu size still depends on ops throughput.** Moving exposure to Tenant Ops clearance widens the
  shelf, but the shelf is still bounded by verification throughput. It must not be widened further
  by loosening the entity-fact predicate.

---

*Decision document only. No code, schema, or data was changed in producing it.*
