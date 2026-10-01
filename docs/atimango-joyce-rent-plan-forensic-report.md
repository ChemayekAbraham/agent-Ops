# Atimango Joyce — Rent Plan forensic report

**Prepared** 2026-10-01 · **Tenant** Atimango Joyce (`783f6897-06bc-4724-81b8-a31b5769df1d`, +256772236357)
**Agent on every plan** SHARIFU KALULE (`98ee118b-06d1-47a4-aa2b-76bd12170b70`)

All figures read directly from production: `rent_requests`, `agent_collections`,
`general_ledger`, `rent_amount_change_log`, `audit_logs`, `system_events`,
`sms_delivery_log`, `v_rent_repaid_reconciliation`. Nothing here is inferred
from a dashboard.

---

## 1. Answer first

| Question | Answer |
|---|---|
| Is the UGX 5,000,000 plan complete? | **No.** UGX 590,000 of 6,670,000 paid — **8.85%**. It is in arrears by 886,004. |
| Did the agent make a double repayment? | **Yes — a triple.** Three UGX 500,000 entries in 66 seconds on 16 September. Two were reversed. |
| Did the system increase float out of the blue? | **Yes, and not just for him.** On 16 September the float gate stopped debiting *platform-wide*. |
| Did he exploit the incident? | **Not proven.** The defect hit 53 agents. But three specific items land in his favour and are still unresolved. |
| Did the tenant get told? | **No.** She received **no SMS at all between 15 and 19 September.** |

---

## 2. Her six Rent Plans

| # | Plan | Rent | Total repayable | Repaid | Status | Funded |
|---|---|---:|---:|---:|---|---|
| 1 | `1b67fd96` | 1,000,000 | 1,350,000 | 1,350,000 | **completed** | 23 Jul 12:44 |
| 2 | `d44b6135` | 3,000,000 | 4,010,000 | 3,740,000 | repaying | 11 Aug 13:43 |
| 3 | `6bfe501a` | **5,000,000** | **6,670,000** | **590,000** | repaying | 17 Sep 12:39 |
| 4 | `12867d95` | 3,000,000 | 4,010,000 | 0 | rejected | never funded |
| 5 | `032dea31` | 3,000,000 | 4,010,000 | 0 | rejected | never funded |
| 6 | `8875cbb8` | 3,000,000 | 4,010,000 | 0 | rejected | never funded |

Plans 4–6 were created at **10:57:11, 10:57:37 and 10:57:42 on 17 September** —
three identical 3M renewals in 31 seconds, 20 seconds after the 5M request was
raised. All three were rejected on 22 September. This is the same
rapid-repeat-submission pattern seen on 16 September, which is worth noting
even though no money attached to them.

---

## 3. The UGX 5,000,000 plan — full timeline

| When (Kampala) | Event | Amount | Float before → after |
|---|---|---:|---|
| 17 Sep 10:56:52 | Request created | 5,000,000 rent | — |
| 17 Sep 11:21:39 | Terms edited — `rent_amount`, `access_fee`, `total_repayment`, `daily_repayment` | — | — |
| 17 Sep 12:39:16 | **Funded** | 6,670,000 repayable | — |
| 25 Sep | Repayment opens (`repayment_starts_on`) | 222,334/day | — |
| 25 Sep 07:00 | "Behind by 1,556,338 (7 days)" SMS | — | *failed (lana)* |
| 25 Sep 07:02 | "Yesterday's 222,334 not received" | — | *failed (lana)* |
| 28 Sep 09:10:42 | Collection | 125,000 | 148,000 → 23,000 ✓ |
| 29 Sep 08:48:53 | Collection | 153,000 | 6,153,000 → 6,000,000 ✓ |
| 30 Sep 09:29:25 | Collection | 170,000 | 170,000 → 0 ✓ |
| 1 Oct 08:50:55 | Collection | 142,000 | 205,000 → 63,000 ✓ |
| | **Total paid** | **590,000** | of 6,670,000 |

**Every one of the four collections on this plan is clean.** The float debit
matches the amount to the shilling, each has a ledger leg, none is reversed, and
the tenant was texted each time. `v_rent_repaid_reconciliation` reports this
plan **`reconciled`** — `amount_repaid` 590,000 = ledger 590,000, nothing
unbacked.

Two observations that are not defects but are unusual:

- **Repayment started 8 days after funding** (17 Sep → 25 Sep), where the rule
  is funded + 1 day. The plan sat idle for a week.
- **The agent tops up his float by the exact collection amount, minutes before
  collecting** — 153,000 deposited at 08:48:05, collected 08:48:53; 170,000 at
  09:29:15, collected 09:29:25; 205,000 at 08:45:06, collected 142,000 at
  08:50:55. That is consistent with taking cash from the tenant and banking it
  to fund the entry. It is not misconduct, but it means the float balance is
  never a buffer, and it is why this plan survived 16 September untouched —
  **it did not exist yet.**

### The agent's claim that she completed

**It is false for this plan**, and the record is not ambiguous: 590,000 of
6,670,000, four payments, and the system texted her on 1 October that
**6,080,000 remains**. She is 886,004 behind.

The likeliest honest explanation for the claim is plan 2, not plan 3. **On
16 September the 3,000,000 plan briefly read 4,010,000 repaid of 4,010,000 — a
full clearance** — before a correction on 22 September pulled it back to
3,740,000. If the agent looked at his screen on 16 September and saw her cleared,
he saw it. It was wrong, and §4 explains why.

---

## 4. The 16 September incident

### What happened, platform-wide

On 16 September the float gate stopped consuming float. Measured across the
whole platform for `collection_channel = 'agent_float'` that day:

| | |
|---|---:|
| Collections recorded | **1,732** |
| Agents involved | **53** |
| Value recorded | **UGX 139,170,926** |
| Float actually consumed | UGX 2,549,377 |
| Rows where `float_before = float_after` | **1,616** |
| Value against zero float movement | **UGX 136,621,549** |

This was not one agent. It was the platform. The reversal note on the two
cancelled entries names it: *"duplicate submission, 2026-09-15 float-gate
defect."*

### SHARIFU KALULE on 16 September

| | |
|---|---:|
| Collections | 18, across 10 tenants |
| Value recorded | **UGX 5,834,551** |
| Float consumed | **UGX 0** |
| Float balance, start and end | 600,000 → 600,000, unchanged all day |
| Reversed afterwards | 1,000,000 |
| **Still live** | **UGX 4,834,551** |

He recorded 5.83 million against a float of 600,000 that never moved. Before
that day his float behaved correctly (15 Sep: four collections, float drained
226,000 → 0). After it, correctly again (17–18 Sep). **The anomaly is one day
wide.**

### Atimango Joyce's share — all on plan 2, not the 5M

| Time | Amount | Reversed? | Credited to her balance? |
|---|---:|---|---|
| 08:57:49 | 500,000 | no | **No** |
| 08:59:43 | 500,000 | **yes**, 17:08 same day | no |
| 08:59:55 | 500,000 | **yes**, 17:08 same day | no |
| 09:55:49 | 500,000 | no | yes → 3,763,000 |
| 09:58:34 | 247,000 | no | yes → 4,010,000 |
| **Recorded** | **2,247,000** | **1,000,000 reversed** | **747,000 credited** |

**Three 500,000 entries inside 66 seconds.** That is the double repayment —
in fact a triple. Two were caught and reversed the same afternoon.

### What the ledger says each entry did

Every one posted the same three legs:

```
cash_receipt_in_transit   cash_in    500,000   "Tenant rent cash received by agent — held in custody"
agent_commission_earned   cash_in     40,000   "10% commission on rent collection allocation"
agent_commission_payable  cash_out    50,000   "Platform commission payout"
```

**There is no `agent_float_used_for_rent` leg anywhere on 16 September** — not
for her, not for anyone. The platform recorded the agent as *holding her cash*,
and paid him commission on it, without his float moving.

---

## 5. Three items that remain unresolved, all in the agent's favour

These are the findings that matter. None of them proves intent; all of them
need answering.

### 5.1 Commission was never clawed back on the reversed entries

The two 500,000 entries were reversed at 17:08 on 16 September. The agent's
wallet commission legs for **16–23 September contain only `cash_in`** — 113
legs, UGX 510,753.60, plus 31,000. **No reversal leg exists.**

He kept roughly **UGX 80,000** of commission on collections the platform itself
declared duplicates.

### 5.2 A 500,000 collection exists in the ledger but never reduced her debt

The 08:57:49 entry is live, carries a full ledger posting and earned
commission — and **her balance did not move.** The 09:55:49 and 09:58:34 entries
moved it; that one did not.

So the platform recorded her as having handed over 500,000, paid the agent
commission on it, and left her owing it.

### 5.3 A 770,000 credit two days earlier, by a different agent, with nothing behind it

| 14 Sep 12:19:13 | `2,320,000 → 3,090,000` | **+770,000** | changed by **GRACE PAUL OCHIENG** |

There is **no collection, no ledger leg and no deposit** behind this. It is a
direct balance write by an agent who does not appear anywhere else on this
tenant's record.

**And this is what makes the books look clean.** The unbacked +770,000, minus
the 500,000 collection that never credited, minus a system correction of
−270,000 on 22 September, nets to zero. Her balance reconciles today **because
two errors cancel**, not because the record is right:

```
+770,000  unbacked credit (14 Sep, GRACE PAUL OCHIENG)
-500,000  collection that was never credited (16 Sep 08:57)
-270,000  system correction (22 Sep 15:26)
---------
       0  net — plan 2 now reads reconciled
```

---

## 6. The completed 1,000,000 plan has its own hole

Plan 1 (`1b67fd96`) is marked **completed** at 1,350,000 repaid. Its collections
total **850,000**. `v_rent_repaid_reconciliation` classifies it
**`untraced_credit`** — **UGX 500,000 unbacked**, with **zero** balance-log rows
and **zero** audit rows.

That plan was closed on money with no origin anywhere in the system. It predates
the 16 September defect (completed 4 September) and is a separate matter.

---

## 7. The late-September float movements

Not the 16th, but the user asked about float appearing from nowhere, and this is
the larger instance:

| When | Movement | Amount |
|---|---|---:|
| 28 Sep 13:28 | Float deposit (airtel) | **+5,000,000** |
| 28 Sep 13:29 | Float deposit (airtel) | **+1,000,000** |
| 29 Sep 11:50 | Operator move out to *Nankambo sharimah (Withdrawable)* — note begins **"not suppos…"** | −6,000,000 |
| 30 Sep 10:52 | Float deposit (airtel) | +3,000,000 |
| 30 Sep 11:55 | Operator move to *KALULE SHARIF (Float)* — "agent partnership" | −3,000,000 |

So the 6,153,000 float visible on his 29 September collection was a 6M deposit
made the previous afternoon, which FinOps pulled back the next morning with a
note saying it was not supposed to be there. **It was caught and corrected
within 22 hours**, and no collection consumed it: the 153,000 collection that
day was separately funded by a 153,000 deposit 48 seconds earlier.

**His wallet today: float 0, withdrawable 0, advance 41,841.**

---

## 8. What the tenant was told

**Between 15 and 19 September she received nothing.** Not one SMS, despite
2,247,000 being recorded against her on the 16th and 1,000,000 of it being
reversed that afternoon. She was neither told she had paid nor told it had been
undone.

Her recent messages, verbatim:

> **1 Oct 09:00** — Welile: We received UGX 142,000. Today's due was UGX 222,334. UGX 80,334 remains and will carry forward. You have now paid UGX 590,000 of UGX 6,670,000, leaving UGX 6,080,000 to pay…

> **1 Oct 07:01** — Welile: Your Rent Plan is behind by UGX 886,004 (4 days). Please pay today from your Welile wallet or through your agent…

> **30 Sep 09:40** — …You have now paid UGX 448,000 of UGX 6,670,000, leaving UGX 6,222,000 to pay…

> **25 Sep 07:00** — Welile: Your Rent Plan is behind by UGX 1,556,338 (7 days)… *(delivery failed — provider lana)*

Two of the 25 September messages **failed to send**, on the `lana` provider. She
was not told her plan had gone into arrears.

---

## 9. Final verdict

**On the 5,000,000 plan: the agent's statement is false.** She has paid 590,000
of 6,670,000 and is 886,004 in arrears. Every collection on that plan is clean
and fully reconciled. There is nothing wrong with the 5M plan except that it is
barely being paid.

**On the double repayment: it happened, and it is visible.** Three 500,000
entries in 66 seconds on 16 September. Two were reversed within nine hours.

**On exploitation: not proven, and the platform-wide evidence argues against
it.** The float gate failed for 53 agents and 136.6 million that day. He was one
of them. A duplicate submission during a defect that removes the balance check
is exactly what a defect of that kind produces, from careless agents and
careful ones alike.

**But three things are unresolved and every one of them favours him:**

1. **~80,000 of commission kept on reversed duplicates**, with no clawback leg
   anywhere in his wallet.
2. **500,000 recorded as received from her, commission paid, debt not reduced.**
3. **770,000 written onto her balance by another agent with nothing behind it**,
   two days before the defect — which is the only reason her account reconciles
   today.

Item 3 is the one I would not leave alone. It is not explained by the
16 September defect, it predates it, and it was done by someone who appears
nowhere else in this tenant's file.

**The honest summary: a platform defect, not a scheme — but a defect whose
cleanup was never finished, and one balance write that the defect does not
explain at all.**

---

## 10. What I could not establish

- **Whether Atimango Joyce actually handed over cash on 16 September, and how
  much.** The ledger records `cash_receipt_in_transit`, which is the agent's
  assertion, not independent proof. No MoMo reference, no deposit id and no
  tracking number ties any of the five entries to a real payment. **Only she can
  settle this**, and she was never texted, so she has no record either.
- **Why GRACE PAUL OCHIENG credited 770,000.** There is no reason field, no
  ledger leg and no linked collection.
- **Whether the 22 September −270,000 correction was aimed at this problem or
  was incidental.** It was made by the system with no actor recorded.

## 11. Recommended next steps

1. **Call the tenant.** Ask her directly what she paid between 14 and 16
   September. She is the only source that can resolve §5.2 and §10. Do this
   before confronting the agent.
2. **Ask GRACE PAUL OCHIENG about the 14 September 770,000.** Separately, and
   first — it is the least explicable item here.
3. **Claw back the commission on the two reversed collections** (~80,000), or
   record why it is being left.
4. **Decide the 500,000 at 08:57:49** — either credit her balance by 500,000, or
   reverse the collection and its commission. It cannot stay as it is.
5. **Audit the other 15 collections from that day**, covering the remaining nine
   tenants and UGX 3,587,551 still live, on the same three questions.
6. **Platform-wide:** 1,616 collections worth 136,621,549 were recorded on
   16 September against zero float. Only this agent's 1,000,000 appears to have
   been reviewed. The rest has not been looked at.

### How to re-run the core query

```sql
-- the 16 September float-gate window, any agent
SELECT count(*) AS collections, count(DISTINCT agent_id) AS agents,
       sum(amount) AS recorded,
       sum(float_before - float_after) AS float_consumed,
       count(*) FILTER (WHERE float_before = float_after) AS zero_delta_rows,
       sum(amount) FILTER (WHERE float_before = float_after) AS zero_delta_amount
  FROM public.agent_collections
 WHERE (created_at AT TIME ZONE 'Africa/Kampala')::date = '2026-09-16'
   AND collection_channel = 'agent_float';
```
