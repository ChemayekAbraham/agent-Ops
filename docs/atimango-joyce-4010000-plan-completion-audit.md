# The UGX 4,010,000 Rent Plan — was it really completed?

**Plan** `d44b6135-b3ce-49c5-96ca-68d7342b1107` · created **4 Aug 2026**
**Tenant** Atimango Joyce (`783f6897-…`, +256772236357)
**Agent** SHARIFU KALULE (`98ee118b-…`) · **Landlord** Emilio Odongo
**Terms today** 3,000,000 rent · 4,010,000 repayable · 133,667/day · 30 days
**Status today** `repaying` — **3,740,000 paid, 270,000 outstanding**

Prepared 2026-10-01 from `rent_requests`, `rent_amount_change_log`,
`audit_logs`, `agent_collections`, `general_ledger`, `system_events` and
`sms_delivery_log`. No data was modified.

---

## 1. The verdict, up front

**The agent is telling the truth about what he saw. The plan *was* marked
`completed` — at 09:58:34 on 16 September 2026.** It is in the change log, in
black and white.

**But the completion was manufactured, and it did not survive review.** Of the
4,010,000 that closed the plan, **1,517,000 — 37.8% — never moved a shilling of
float and has no money behind it.** Six days later the system quietly took it
back and reopened the plan.

```
2,493,000  genuine float-backed collections      62.2%
  770,000  "Balance approved" — no collection    19.2%   ← no money anywhere
  747,000  recorded during the 16 Sep defect     18.6%   ← zero float consumed
---------
4,010,000  = total_repayment  →  status: completed
```

---

## 2. Full timeline

| When (Kampala) | Event | Balance after | Backed by money? |
|---|---|---:|---|
| **4 Aug 11:14:08** | Created — as a **UGX 1,000,000** request (total 1,350,000, daily 45,000) | 0 | — |
| **5 Aug 11:01:43** | **JANEHEPHZIBAR GIMONO**, reason *"Correct amount"* — rent 1,000,000 → **3,000,000**, access fee 330,000 → 990,000, total → **4,010,000**, daily → 133,667 | 0 | terms only |
| 5 Aug 11:16 | Landlord verification bonus 5,000 paid to agent (Emilio Odongo) | — | — |
| **11 Aug 13:43:54** | **Funded** by SARAH ANGWEN — note *"Batch: Testing"* | 0 | — |
| 12 Aug | Repayment opens, 133,667/day for 30 days → term ends ~10 Sep | | |
| 13 Aug – 5 Sep | 11 collections × 135,000 | 1,485,000 | ✅ float debited each time |
| 8 Sep 09:16 | +140,000 | 1,625,000 | ✅ |
| 9 Sep 12:35 | +150,000 | 1,775,000 | ✅ |
| 10 Sep 10:12 | +150,000 | 1,925,000 | ✅ |
| 12 Sep 20:46 | +185,000 | 2,110,000 | ✅ |
| 13 Sep 19:27 | +210,000 | 2,320,000 | ✅ |
| **14 Sep 12:19:13** | **GRACE PAUL OCHIENG — reason *"Balance approved"* — +770,000** | **3,090,000** | ❌ **no collection, no ledger leg, no deposit** |
| 15 Sep 07:54 | +173,000 | 3,263,000 | ✅ last clean collection |
| **16 Sep 08:57:49** | Collection 500,000 — commission paid | **3,263,000** | ❌ zero float · **balance never moved** |
| **16 Sep 08:59:43** | Collection 500,000 | — | ❌ zero float · **reversed 17:08** |
| **16 Sep 08:59:55** | Collection 500,000 | — | ❌ zero float · **reversed 17:08** |
| **16 Sep 09:55:49** | Collection 500,000 | 3,763,000 | ❌ zero float |
| **16 Sep 09:58:34** | Collection **247,000** | **4,010,000** | ❌ zero float — **status → `completed`** |
| **17 Sep 10:56:52** | UGX **5,000,000** renewal raised | | |
| 17 Sep 10:57:11 / :37 / :42 | Three more 3,000,000 renewals, 31 seconds apart | | all later rejected |
| **17 Sep 12:39:16** | **5,000,000 renewal funded** | | |
| 21 Sep 17:18 | 12 ledger "A3 correction" reversals on this plan | | |
| **22 Sep 15:26:33** | **System: 4,010,000 → 3,740,000, status → `repaying`** | **3,740,000** | correction |
| 22 Sep 22:57 | Receivable restatement, 2,730,000 | | |
| Today | **270,000 still owed** | 3,740,000 | |

---

## 3. The three things that made it "complete"

### 3.1 The 770,000 "Balance approved" — the most serious item

On **14 September at 12:19:13**, GRACE PAUL OCHIENG — an operator who appears
**nowhere else** on this tenant's entire file — raised the balance by 770,000
through the Tenant Ops correction route.

The audit record shows the edit changed **nothing except `amount_repaid`**:

```
before: { rent 3,000,000, access_fee 990,000, total 4,010,000, amount_repaid 2,320,000 }
after:  { rent 3,000,000, access_fee 990,000, total 4,010,000, amount_repaid 3,090,000 }
reason: "Balance approved"
```

**There is no collection at that timestamp, no ledger leg, and no deposit.**
UGX 770,000 of the tenant's debt was written off by typing a number. The reason
given — *"Balance approved"* — describes an approval, not a payment.

This is exactly the hole you ordered closed on 2026-09-28, when every tenant
balance change was made to queue for CFO approval. **This edit predates that
control by two weeks.**

### 3.2 The 747,000 recorded during the 16 September float-gate defect

On 16 September the float gate stopped debiting **platform-wide**: 1,732
collections, 53 agents, UGX 139,170,926 recorded against UGX 2,549,377 of float
actually consumed. On this plan, five entries totalling 2,247,000 were recorded
with `float_before = float_after = 600,000` on every one.

They posted as `cash_receipt_in_transit` — *"Tenant rent cash received by agent,
held in custody"* — with commission paid, and **no `agent_float_used_for_rent`
leg exists anywhere on the platform that day.**

**The last entry is the one to look at.** At 09:58:34 the agent recorded exactly
**247,000**, two minutes and forty-five seconds after a 500,000 entry.

```
4,010,000  total repayable
3,763,000  balance at 09:55:49
-----------
  247,000  exactly what was left
```

A tenant handing over cash does not produce a figure that lands on the
outstanding balance to the shilling. **That entry was sized to close the plan.**

### 3.3 A 500,000 collection that charged her and credited her nothing

The 08:57:49 entry is live, has a full ledger posting and earned the agent
40,000 commission — **and her balance did not move.** The two later entries
moved it; this one did not.

So the platform recorded her as having handed over 500,000, paid commission on
it, and left her owing it.

---

## 4. What the 22 September correction did — and did not do

At 15:26:33 on 22 September the system wrote the balance down by 270,000 and
set the status back to `repaying`. No actor is recorded; it carries no reason
and matches no named job in `system_events`. It sits between the A3 ledger
corrections of 21 September and the receivable restatement of 22 September, so
it was almost certainly part of the clean-up after the 16 September incident.

**It landed the balance at 3,740,000, which is exactly the sum of the live
collections.** The plan now reports `reconciled`.

But look at what that arithmetic actually is:

```
+770,000   unbacked "Balance approved" (14 Sep)
-500,000   collection that was never credited (16 Sep 08:57)
-270,000   system correction (22 Sep)
--------
        0
```

**The books balance because two errors cancel.** The correction removed the
*net* surplus without touching either underlying fault. The 770,000 with no
money behind it is still in her paid total. The 500,000 she was charged and not
credited for is still missing. They simply offset.

And the clean-up was partial in a second way: **the commission was never clawed
back.** The agent's wallet shows only `cash_in` commission legs for 16–23
September — 113 legs, UGX 510,753.60. He kept roughly **80,000** on the two
entries the platform itself declared duplicates.

---

## 5. On the renewal that followed

The plan completed at **09:58 on 16 September**. The UGX 5,000,000 renewal was
raised at **10:56 the next morning** and funded at **12:39** — under two hours
from application to money.

**I am not asserting the completion was engineered to unlock it.** Two facts cut
against that reading, and they belong in this report as much as the sequence
does:

- Both plans are open **today** — the 3M reverted to `repaying` on 22 September
  while the 5M stayed funded. The platform evidently tolerates concurrent plans,
  so completion may not have been required at all.
- I could find **no renewal-eligibility function** that gates on a prior plan
  being `completed`.

What can be said plainly: a plan was closed using 1,517,000 of unbacked credit,
and the next morning the same agent obtained 5,000,000 on a renewal. Whether
those facts are connected needs a person to ask, not a query.

---

## 6. Two record-keeping problems found along the way

**The 5 August correction is recorded twice, differently.** `audit_logs` says
the edit left `access_fee` at 330,000 and `total_repayment` at 3,350,000.
`rent_amount_change_log`, same timestamp, says 990,000 and 4,010,000. The
likeliest explanation is that the audit row captured what the operator
submitted and a trigger then recalculated the fee to the correct 33%. It is
benign here, but it means **the two audit trails for plan edits do not agree**,
and anyone reconciling from `audit_logs` alone would get the wrong terms.

**The plan was funded with the note "Batch: Testing."** A 3,000,000 disbursement
to a real tenant carries a funding note saying it was a test.

---

## 7. Final verdict

**Was it completed?** Yes — the system marked it `completed` at 16 Sep 09:58:34.
The agent is not inventing that.

**Was the completion real?** No. **1,517,000 of the 4,010,000 — 37.8% — had no
money behind it**: 770,000 typed in as a "Balance approved" correction, and
747,000 recorded while the platform-wide float gate was off. Strip those and the
tenant had genuinely paid **2,493,000 of 4,010,000 — 62%.**

**Was anything shady done to it?** Two things cross the line from defect into
deliberate action, and only one of them is the agent's:

1. **The 770,000 "Balance approved" by GRACE PAUL OCHIENG on 14 September.**
   No collection, no ledger, no deposit, no money. Someone approved a balance
   that did not exist. This is the single most serious finding in this file, and
   it is **not** the collecting agent.
2. **The 247,000 entry at 09:58:34**, sized to the shilling to close the plan,
   recorded during a defect window that had removed the float check. The float
   failure was platform-wide and not his doing — **choosing that exact figure
   was.**

**Where it leaves the tenant.** She has paid 2,493,000 of real, float-backed
money against a 4,010,000 plan. The record says 3,740,000. **She is credited
with roughly 1,247,000 more than the evidence supports** — and separately was
charged 500,000 she never received credit for. On this plan the errors happen to
favour her; on the ledger they do not reconcile with reality at all.

---

## 8. What I could not establish

- **Whether she actually paid cash on 16 September.** `cash_receipt_in_transit`
  records the agent's assertion. No MoMo reference, deposit id or tracking
  number ties any of the five entries to a real payment, and **she received no
  SMS between 15 and 19 September**, so she holds no record either.
- **Why GRACE PAUL OCHIENG approved 770,000.** The reason field says only
  "Balance approved". There is no supporting document, ticket or ledger entry.
- **What ran at 22 Sep 15:26:33.** No actor, no reason, no matching job.

## 9. Recommended actions

1. **Ask GRACE PAUL OCHIENG about the 14 September 770,000 first**, before
   anyone speaks to the agent. It is the one item no defect explains.
2. **Call the tenant.** Ask what she paid between 14 and 16 September. She is
   the only source that can settle §3.3.
3. **Resolve the 08:57:49 collection** — credit her 500,000 or reverse the
   entry and its commission. It cannot stay as it is.
4. **Claw back the ~80,000 commission** on the two reversed duplicates, or
   record why not.
5. **Re-examine the 5,000,000 renewal** funded 17 September on the strength of a
   completion that was reversed on 22 September.
6. **Platform-wide**: 1,616 collections worth **136,621,549** were recorded on
   16 September against zero float. Only 1,000,000 of it has been reviewed.

### Re-run the completion trail

```sql
SELECT (changed_at AT TIME ZONE 'Africa/Kampala') AS when_kampala,
       old_amount_repaid, new_amount_repaid,
       new_amount_repaid - old_amount_repaid AS delta,
       status, changed_by
  FROM public.rent_amount_change_log
 WHERE rent_request_id = 'd44b6135-b3ce-49c5-96ca-68d7342b1107'
 ORDER BY changed_at;
```
