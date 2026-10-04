# Where the unbacked plan balance came from

**Investigated 2026-09-28, after the rankings-board question. Findings only — nothing in here has been changed.**

## The question

`rent_requests.amount_repaid` totals **UGX 658,861,483** across the platform.
Recorded cash comes to **374,136,222** of live agent collections plus
**119,681,158** of `repayments` rows. Crediting both in full still leaves
**≈257,378,699 across 215 plans** with no payment record behind it.

`amount_repaid` is what a tenant is told they have paid, what their progress bar
shows, and what the Service Centre rankings board adds up. So: where did a
quarter of a billion shillings of "repaid" come from?

## The answer, in one line

**It was typed in.** 261 tenant-ops corrections changed `amount_repaid` between
17 July and 25 September; **219 of them raised it, by a net UGX 201,096,194** —
78% of the gap. Every one went through an authorised function with a reason and
an audit row. This is not a bug. It is a controls question.

## Where it sits

Two agents carry 80% of it:

| Agent | Plans | Unbacked UGX |
| --- | ---: | ---: |
| IAN MUHWEZI | 45 | 118,538,806 |
| JAMES KATONGOLE | 36 | 87,048,689 |
| Thomas hawahka | 18 | 6,278,500 |
| ALPHA SSEMA | 7 | 5,300,600 |
| *(29 others)* | 109 | ~40,000,000 |

144 of the 215 sit at `amount_repaid = total_repayment` **exactly**. They are
plans marked fully repaid, not plans drifting.

The concentration by cohort is July (92.4m), September (72.9m), August (65.1m).
Nothing before May matters.

## The mechanism

`tenant_ops_correct_rent_request` accepts `p_amount_repaid` and writes it
straight to the plan. It is gated on `is_tenant_ops_staff`, it demands a reason,
and it logs `tenant_ops_rent_request_correction` with before/after in
`metadata`. Two sibling paths, `ops_edit_tenant_balance` (CFO approval since
14 September) and `ops_record_payment_edit`, account for another 372 audited
edits.

Who raised balances, and by how much:

| Editor | Edits | Net added UGX | Largest single |
| --- | ---: | ---: | ---: |
| JAMES KATONGOLE | 69 | 86,687,008 | 3,345,000 |
| JANEHEPHZIBAR GIMONO | 145 | 76,665,981 | 5,340,000 |
| Nankambo sharimah | 33 | 35,546,262 | 3,914,239 |
| GRACE PAUL OCHIENG | 6 | 2,091,613 | 770,000 |
| PRISCILLA LOLEM | 1 | 105,330 | 105,330 |
| Kisakye Natasha | 7 | 0 | — |

## Finding 1 — two people edited the balance on plans they are the agent on

| | Edits | Net added UGX | Editors |
| --- | ---: | ---: | ---: |
| Edited **their own** plan | 45 | **79,980,321** | 2 |
| Edited someone else's plan | 216 | 121,115,873 | 6 |

JAMES KATONGOLE's own figures line up almost exactly: **+86,687,008 edited**
against **87,048,689 unbacked** on the 36 plans where he is the agent. His
roster is 49 plans across **7 tenants and 4 landlords**, 47 of them completed.

His roles: `agent, agent_ops, employee, landlord, manager, operations,
supporter, tenant, tenant_ops`. He is the agent, the landlord, and the
tenant-ops staff member who corrects the balance. Others in the table hold
similar stacks — JANEHEPHZIBAR GIMONO is `agent … manager, tenant_ops`,
Nankambo sharimah is `agent … coo, financial_ops`.

**This is a separation-of-duties gap, not proof of anything.** A field agent who
also does tenant-ops may well be correcting plans they genuinely know best. But
nothing in the system currently stops the same person recording the money and
approving that it was recorded, and 79,980,321 has gone through that door.

## Finding 2 — the ledger was then restated to agree with the column

On 22 September the Book of Accounts correction restated the A3 rent receivable
**to each plan's operational outstanding balance**. Its own description says it:

> *"sets the recorded receivable for rent plan … to its operational outstanding
> balance of 0.00 (was 5,340,000.00)"*

**428,230,339 of receivable was written down across 939 plans**, balanced to
equity. `amount_repaid` was treated as the source of truth and the books were
moved to match it.

That inverts the usual safety net. Normally a wrong operational field is caught
because the ledger disagrees. Here, **any error in `amount_repaid` that existed
on 22 September became a permanent write-off.** For IAN MUHWEZI's plans alone
that is 133,143,415.

Worked example — plan `077695ca`, funded 8 September, rent 4,000,000, total
repayment 5,340,000 over 30 days:

- collections recorded 9–21 September: ~1,080,000
- `amount_repaid` on 21 September: **5,340,000**, status `completed`
- 22 September: 5,340,000 of receivable written off, because the plan said zero
  outstanding
- no `audit_logs` row on that plan after 8 September

Four more of IAN's plans carry the identical 5,340,000 write-off.

## Finding 3 — one path leaves no audit row at all

RLS policy **"Managers can update requests"** on `rent_requests` is
`USING has_role(auth.uid(), 'manager')` with **`WITH CHECK` null** — no column
restriction. And `guard_rent_request_agent_updates`, the trigger that rewrites
`NEW.amount_repaid` back to `OLD` for untrusted allocations, returns `NEW`
immediately for `is_sensitive_field_editor` **or** `manager`.

So a manager can `PATCH /rent_requests?id=eq.…` with `{"amount_repaid": …}`
straight from the client. No RPC, no reason, no audit row. **31 accounts hold
`manager`.**

The frontend ledger-write guard does not catch this, correctly — `rent_requests`
is not a wallet or ledger table. But `amount_repaid` is money in every way that
matters to a tenant.

This is consistent with plan `077695ca` changing on 21 September with nothing in
`audit_logs`.

## What I would do, in order

1. **Add `WITH CHECK` to the manager update policy** so `amount_repaid`,
   `total_repayment`, `rent_amount` and `daily_repayment` cannot move through
   plain RLS. Anything that must change them goes through an RPC that logs.
   Cheapest fix, closes the unaudited door.
2. **Block self-editing** in `tenant_ops_correct_rent_request`: refuse when the
   caller is the plan's `agent_id` or `assigned_agent_id`. 45 edits and
   79,980,321 would have needed a second pair of hands.
3. **Review the 219 raises** — with 428,230,339 already written off against
   them, this is a finance review, not an engineering one. Start with the 45
   self-edits and the 5,340,000 cluster.
4. **Re-anchor the restatement** only if 3 finds real errors. The ledger is
   internally consistent today; moving it again without a verdict makes things
   worse.

`plan_balance_unbacked` in the CTO Monitor tracks the rate from here.
