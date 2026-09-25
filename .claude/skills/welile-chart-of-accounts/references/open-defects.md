# Open defects

**The books do not currently balance.** Treat "the balance sheet balanced after
my change" as meaningless — test per group instead.

Blueprint figures are **as at 2026-09-24**; the derived section is **25 Sep 2026**.
**Re-derive before quoting any of them.**

---

## From the blueprint

### D1 — A2 conflates a company asset with customer money (root defect)

| Origin | Amount |
|---|---:|
| Company-supplied (`merchant_float_deliveries`, `cfo_direct_credit` allocations) | 2,141,755,733 |
| User-supplied (agents' own `deposit_requests`) | 1,715,709,823 |

A2 is an asset, L1 a liability, and a user's money can sit in either. Every
Float ↔ Withdrawable move therefore crosses the balance sheet and mechanically
creates a 2× artefact.

**Fix:** split A2 — company float stays, user-funded float moves to L1. D2 is
downstream of this.

### D2 — the balance sheet is unbalanced

≈ **+1,012,040,798** (excess debits):

| Component | Groups | Residual |
|---|---|---:|
| Cross-bucket groups where the X4 synthetic fires | 679 / 1,035 | +809,735,372 |
| Cross-bucket groups not gated | 236 / 1,976 | +215,505,426 |
| `agent_advance_topups` (`rent_disbursement`→A1/CR + `agent_advance_credit`→L1/CR) | 6 | (13,000,000) |

The first arose on 2026-09-23 when the X4 counterpart shipped without its
companion mapping change.

Evidence gathered 2026-09-24 established Float ↔ Withdrawable is **economically
neutral**: 595 of 1,036 groups are same-user bucket moves, float is not
withdrawable, and total obligation is identical before and after. **Correct
treatment is DR L1 / CR L1 — no X4, no A2.**

### D3 — cash deposits, malformed but correctly reported

37 `personal_deposit` physical-cash groups (**333,255,000**) post four legs
(DR A5 / CR A2 / CR L1 / CR L1) because the wallet leg became purpose-aware on
2026-09-07 and the platform legs did not.

The `agent_float_cash_offset` → L1 override rescues them: they resolve to
DR A5 / CR L1 and **the published reports are correct**. The 666,510,000
residual exists only in the trigger's view.

Forward fix deployed 2026-09-24, commit `f905c1182c`. **No historical correction
is required or safe** — posting reversals would unbalance groups that currently
balance.

### D4 — A4 carries a credit balance

**(1,268,864,881)** — an asset with a credit balance, contaminated with
corrections and test data. Excluded from receivables reporting.

### D5 — L3 has never been used

Zero legs, ever. Partner Returns are expensed to X2 and credited straight to
wallets (L1). The obligation is captured, but the Returns Payable line reads nil
permanently.

### D6 — L5 nets to zero against a real obligation

34 legs, accrued and settled in the same period. Operationally **16,157,500**
accrued-unpaid commission plus **6,527,029** queued proxy commission sit with no
liability account.

### D7 — other

- **A5 = 754,737,090** of collected cash with no banking entry, against records
  stating "Deposited on bank"
- **933 self-approved deposits, 521,230,452 in 14 days** (creator = approver)
- **CFO debit obligations 1,034,280,305** across 1,077 rows — no identified
  account
- **L2 is 997,215,780 above active portfolios**
- `merchandise_revenue` unmapped → resolves to A9
- A15 redundant; A10/A4 overlap

---

## Derived 25 September 2026 — not in the blueprint

Found by running the planned Rent Plan changes through the blueprint's
"adding a new money flow" checklist.

### D8 — cancelling a Rent Plan strands the fee receivable ⚠

`cancel_tenant_and_return_landlord_float` reverses **only the principal**:

```
platform rent_disbursement       cash_in  → DR A1
bridge   rent_receivable_created cash_out → CR A3
```

It never touches `recognise_funding_treasury`'s pair
(`fee_receivable_created` → DR A3, `treasury_fee_recognised` → CR L7). So every
cancellation after funding leaves the **access fee + registration fee** as a
receivable in A3 against a plan that no longer exists, with the matching credit
parked in L7 forever.

| | 25 Sep 2026 |
|---|---:|
| `fee_receivable_created` legs / total | 241 / **53,188,021** |
| `treasury_fee_recognised` legs / total | 242 / **54,128,313** |
| Closed plans already carrying a stranded fee receivable | **1 / 119,000** |

Small today because post-funding cancellation is rare. **Any automatic
cancellation rule makes it routine** — roughly 102,500 stranded per cancelled
250,000 plan.

**The reversal is constructible but must be exact:** bridge
`fee_receivable_created` cash_out (CR A3) + platform `treasury_fee_recognised`
cash_out (DR L7) balances on base mapping. Both are **treasury categories**, so
`trg_enforce_ledger_group_mapped_balance` will **raise, not log**, if it is
wrong.

Also worth checking: the 241 / 242 leg asymmetry and the 940,292 difference
between the two totals.

### D9 — agent commission is split across X1 and X3

The expense account is decided by the **platform** leg's category, and the paths
disagree:

| Paid by | Platform leg | Lands in |
|---|---|---|
| Collection commission (10% / 8% / 2%) | `agent_commission_payable` | **X3** |
| `fund-agent-landlord-float` flat bonus | `agent_commission_earned` | **X3** |
| `credit_agent_event_bonus` | `marketing_expense` | **X1** |
| Landlord / LC1 registration bonus | `marketing_expense` | **X1** |
| **1% landlord-payout commission** | `marketing_expense` | **X1** |

Anything reporting "what we pay agents" must sum **both** X1 and X3, or the
categories must be aligned deliberately.

**This matters for the planned change** that removes the flat 5,000 at funding
and leaves the 1% as the only payment at the landlord-paid stage: that stage
would move entirely out of X3 into X1, understating agent commission expense and
overstating marketing, with nothing looking wrong. Switching the 1%'s platform
leg to `agent_commission_payable` (→ X3) keeps it in the right account and still
balances — but `grep -rn "agent_commission_payable" supabase/functions/` first.

### D10 — `recruiter_override` is unmapped

Zero rows in `ledger_account_map`, so any leg would resolve to **A9** and vanish
from reporting. **Zero legs have ever carried it**, so there is no damage — but
the dormant `credit_recruiter_override` overload that posts it is a trap and
should be deleted rather than left in place.

Related: production has **two** functions named `credit_recruiter_override` with
different signatures, different subagent tables, different status predicates and
different amounts. One should be dropped.
