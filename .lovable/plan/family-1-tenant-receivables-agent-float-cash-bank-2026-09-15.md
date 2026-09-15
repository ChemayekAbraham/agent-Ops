# Family 1 — Tenant Receivables, Agent Float, Cash & Bank

Read-only investigation complete. Nothing was changed: no code, no ledger row, no posting function, no migration.

## The intended economic flow (established from the live posting function, not assumed)

A rent plan is funded first: the company pays the landlord and the tenant owes the whole repayment amount. That obligation is recognised once, when the plan is funded.

When the tenant then pays an instalment, the live collection routine does exactly three economic things:

1. The tenant owes less — the outstanding amount drops by the payment.
2. The money the agent was holding on the company's behalf drops by the same amount (it has been used to settle that tenant's rent).
3. The agent earns 10% commission, paid separately.

So a collection must **reduce tenant receivables** and **reduce cash held with agents**. It must never increase either.

## 1. Exact root cause

Between May and 8 September 2026 the collection routine labelled the tenant's side of every collection as **"rent receivable created"** instead of **"tenant repayment"**. The reporting chart of accounts reads "receivable created" as *new debt*, so each of those payments was presented as the tenant owing **more**, not less. The routine was corrected around 8 September and now writes the right label, so this is a historical labelling problem, not an ongoing one.

Two further, separate problems inflate the same three lines:

- The float line is built from the **payment label** on each ledger line, while the true agent float is built from the **wallet pocket** the money sits in. The two disagree on 7,682 lines.
- A large number of collections and plan fundings were recorded in the operational records but never posted to the ledger at all.

## 2. Incorrect direction currently presented

Per affected collection: **DEBIT Tenant Receivables / CREDIT Cash at Hand — Float with Agents**
(tenant debt goes up, agent cash goes down)

## 3. Expected direction

Per collection: **DEBIT Cash at Hand — Float with Agents is not created at all; the correct entry is CREDIT Tenant Receivables / CREDIT nothing else on the receivable side**, i.e. the collection is presented as:

**CREDIT Tenant Receivables (debt down) / CREDIT Cash at Hand — Float with Agents (cash used), balanced by the rent already disbursed** — exactly what the post-8-September label produces today.

## 4. Affected accounts

| Line | Effect today |
|---|---|
| Receivables from Tenant Products and Services | overstated |
| Cash at Hand — Float with Agents | overstated |
| Cash and Bank Balances | affected only indirectly; its large negative comes from a different family (float deposits/withdrawals) |

## 5–7. Numbers

**Tenant Receivables**

| Item | Amount (UGX) |
|---|---|
| Displayed | 1,007,455,585 |
| True outstanding (funded plans, operational records) | 346,847,948 |
| Difference | 660,607,637 |

Made up of:

| Cause | Lines | Effect on the displayed figure |
|---|---|---|
| Collections labelled "receivable created" (May–8 Sep) | 10,794 collections, 274,258,781 | +548,517,562 (counted as debt added instead of debt cleared) |
| Repayments recorded operationally but never posted to the ledger | — | +225,527,159 |
| Plan fundings never posted to the ledger | — | −114,504,428 |
| Receivables recognised on plans that were later rejected/cancelled | — | +4,786,000 |
| Small residual (pool deployments, other) | — | ≈ +2,281,344 |

**Cash at Hand — Float with Agents**

| Item | Amount (UGX) |
|---|---|
| Displayed | 111,514,284 |
| Ledger-derived agent float | 28,397,916 |
| Wallet float balances | 26,584,416 |
| Difference | ≈ 83,116,368 |

Made up of: 7,619 lines (net +154,445,469) counted as agent float although the money is not in the float pocket, and 63 lines (net −165,624,000) that are float but excluded from the line, plus the collection-side direction flips above.

**Cash and Bank**: displayed −158,125,043, company cash alone −836,422,148. The rent-collection family contributes only ≈ 1.9m of this. The −836m is driven by float deposits and balance corrections (46.8bn of gross paired flows) and belongs to a **separate family** — I recommend not touching it in this step.

**Expected balances after the corrections proposed below**

| Line | Now | After reporting fix | After posting backfill |
|---|---|---|---|
| Tenant Receivables | 1,007,455,585 | ≈ 458,938,023 | ≈ 346,847,948 |
| Float with Agents | 111,514,284 | ≈ 28,397,916 | 28,397,916 |
| Cash and Bank | −836,422,148 | ≈ unchanged | separate family |

## 8. Reporting layer or posting layer?

Both, in that order:

- **Reporting layer (safe, reversible):** the historical mislabel and the float-line definition. This recovers 548.5m of the 660.6m receivable error and effectively all of the float error. No ledger row changes.
- **Posting layer (needs its own approval):** the collections and plan fundings that were never posted at all (225.5m and 114.5m). These are missing records; no reporting rule can honestly supply them.

## 9. Historical ledger entries

They must and will remain untouched. No amount is edited, no row is deleted, no back-dated posting is inserted in the reporting step.

## 10. Safest implementation approach

**Step 1a — Receivables direction (reporting only).** Add one rule to the reporting resolver: a "rent receivable created" line whose source is a collection is a **settlement**, so it credits Tenant Receivables and the paired agent-float line stays a credit. Restricted to collection-sourced lines, so genuine plan fundings are unaffected. Ongoing collections already carry the correct label and are untouched.

**Step 1b — Float line definition (reporting only).** Base Cash at Hand — Float with Agents on the wallet float pocket rather than the payment label, so the line reconciles line-for-line to the ledger-derived float.

**Step 1c — Missing postings (separate approval).** Produce an itemised schedule of the collections and fundings absent from the ledger, for your decision on whether they are posted forward-dated as a correction batch, or presented as a labelled reconciliation line. No back-dating, no altering of history.

**Verification after each step, independently:** rebuild receivables from the plans, float from the wallets, confirm Assets = Liabilities + Equity is still exactly zero at 30 Apr, 30 Jun, 31 Jul, 31 Aug and today, and confirm no ledger row changed.

Steps 1a and 1b only after you approve. 1c only after you decide separately.
