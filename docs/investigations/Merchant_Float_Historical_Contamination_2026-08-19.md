# Merchant Float Historical Contamination — Read-Only Trace

**Date:** 19 Aug 2026 (anchor `merchant_float_anchor_date` = 2026-08-01)
**Scope:** platform-wide "Money we must send back to them" on `MoneyWithAgentsCard`
**Writes performed:** none. No ledger row, wallet row, projection row or reconciliation row was
created, updated or deleted in producing this report.

---

## 1. Headline

The card currently shows **UGX 88,193,296** (this pass measures **UGX 88,203,296**; the ~UGX 10k
difference is one payout that straddles the desk-attribution rule, see cause C3).

**Finding: the entire figure is attribution contamination. Under an evidence-based definition of
"paid out from the desk's float", every active desk owes UGX 0.**

Only five active desks contribute:

| Desk (agent) | paid_out (board) | float-leg-backed payouts | credits | adjustments | owed shown | owed if float-backed only |
|---|---|---|---|---|---|---|
| Sky Bubbles (BAITA) | 220,403,745 | 134,893,274 | 147,230,000 | +30,317,606 | **42,856,139** | 0 |
| Bayo Mercy (Merchant Agent) | 120,165,267 | 51,092,000 | 87,751,300 | −8,894,064 | **41,308,031** | 0 |
| Mudumba Samuel (ENTEBBE) | 45,523,797 | 31,457,916 | 32,950,625 | +9,362,776 | **3,210,396** | 0 |
| Babrah Tusingwire | 5,980,977 | 4,042,437 | 5,534,354 | 0 | **446,623** | 0 |
| Nakajjubi Shamirah | 4,450,855 | 3,403,455 | 4,068,748 | 0 | **382,107** | 0 |
| **Total** | **396,524,641** | **224,889,082** | **277,535,027** | **+30,786,318** | **88,203,296** | **0** |

`owed_to_agent = GREATEST(paid_out_total − (float_credits_recorded + adjustments_total), 0)`.
The defect is on the **`paid_out_total`** side: it is built from `withdrawal_requests` attribution
(`assigned_cashout_agent_id = desk OR processed_by = desk.agent_id`), not from the float debits the
desk actually incurred (`general_ledger`, `wallet_bucket='float'`, `direction='cash_out'`,
`category='agent_float_settlement'`). Payouts the company settled itself are therefore booked as if
the agent had fronted the money.

Cross-check on the biggest desk: Sky Bubbles float credits 147,230,000 = settlement debits
133,448,259 + evidenced write-down 13,781,741, exactly. The desk consumed precisely what it was
credited — there is no unreimbursed principal.

---

## 2. Contamination causes, measured

| Code | Cause | Amount in `paid_out_total` | Affected desks |
|---|---|---|---|
| C1 | **Bank-transfer payouts** attributed to a merchant desk with no float settlement leg. Company bank paid the customer; the desk's phone float was never touched. | 99,506,507 | Sky Bubbles 81,010,471; Bayo Mercy 18,496,036 |
| C2 | **Non-bank payouts with no float settlement leg** (mobile money / cash dispatched outside the merchant float path, including self-withdrawals). | 72,129,052 | Bayo Mercy 50,577,231; Mudumba 14,065,881; Sky Bubbles 4,500,000; Babrah 1,938,540; Nakajjubi 1,047,400 |
| C3 | **Cross-desk double attribution** — a withdrawal assigned to desk A but `processed_by` the agent of desk B is counted for both. 10 withdrawals, appearing twice. | 10,107,036 (10,094,036 of it on Bayo Mercy) | 2 desk pairs |
| C4 | **Unposted `display_only` correction rows** shifting `adjustments_total`, authored without finance authority and in part self-authored. | net −8,894,064 on Bayo Mercy (raises her owed by that amount); +30,317,606 on Sky Bubbles and +9,362,776 on Mudumba (lower theirs) | 3 of the 5 |

### C2 detail — the two self-payouts
`Bayo Mercy` (user `cfa56623…`) is the withdrawing user, the processor **and** the desk owner on two
18 Aug mobile-money withdrawals: UGX 50,000,000 and UGX 42,850,331. The 42,850,331 leg has no float
settlement leg and lands wholly inside C2. A desk owner withdrawing their own wallet is recorded by
the board as "she paid our customer from her float".

### C4 detail — authorship of `merchant_float_reconciliations`
All 159 rows on the table, by author:

| Author | Rows | Amount | Desks | Finance role? |
|---|---|---|---|---|
| Bayo Mercy | 77 | 619,078,503 | 16 | No (`manager` only) — merchant agent |
| Nankambo Sharimah | 39 | 152,796,161 | 17 | Yes |
| Angwen Sarah | 10 | 76,996,856 | 10 | Yes |
| Joshua Wanda | 23 | 55,569,963 | 10 | Yes |
| bwayo mark | 4 | 3,689,399 | 2 | No |
| TESTING DON'T WITHDRAW | 4 | 1,404,476 | 2 | No |
| Benjamin Muhanguzi | 2 | 110,884 | 1 | Yes |

Unposted (display-only, i.e. board-affecting) rows authored by non-finance actors still carry a
signed effect of up to −194,100,452 on a single desk (Nankambo desk, authored by Bayo Mercy) and
−121,309,410 on another. Those desks currently show owed = 0 only because the negative side is
clamped by `GREATEST(..., 0)` — the contamination is present but invisible.

Evidence notes on the 17–18 Aug batch include `0 NOT SUPOIUJHDE GFF`, `0 NGBGFFFHHGGG VHHHJ` and
several blanks: the ≥10-char reason requirement is satisfied by keyboard noise.

---

## 3. Ledger rows still standing (no repair proposed in this pass)

Per-desk float legs since the anchor, for the five contributing desks:

- `agent_float_deposit` cash_in, production — 277,535,027 (the reimbursement base; **none** of it is
  classified `admin_correction`, so the credit-side classification filter is not distorting this
  headline today).
- `system_balance_correction` cash_out, `admin_correction` — 70,321,538 across 15 legs (Bayo Mercy
  52,842,000; Sky Bubbles 13,781,741; Mudumba 3,048,347; Babrah 2,000,000; Nakajjubi 649,450).
- `agent_float_deposit` cash_out, `admin_correction` — 7,660,000 across 5 legs (Bayo Mercy 5,660,000;
  Babrah 2,000,000) — this is the shape produced by the two duplicate 14 Aug reversal migrations.
- `agent_float_assignment` cash_out, production, `FXW-/ECW-/FLT-` references — 34,822,861 (Bayo Mercy
  34,295,800; Mudumba 527,061) — general-purpose float→withdrawable reclassification tooling firing
  against merchant desks.

These legs do not move `owed_to_agent` (it reads only cash_in credits and payout attribution), but
they are the population behind `ledger_float_held` / the clamp artifact and must be part of any
remediation of the *held* figure.

---

## 4. Remediation options (for decision, not executed)

Ordered by blast radius. None of these has been run.

1. **Reporting-side fix (recommended first, zero financial risk).** Redefine `paid_out_total` in
   `get_merchant_float_positions()` as the desk's own `agent_float_settlement` float debits, and keep
   the `withdrawal_requests` figure as a separate `payouts_dispatched` column for operations. This
   alone takes the headline from 88.2m to 0 without touching a single ledger row, because it stops
   asserting a debt the books never recorded. Add `DISTINCT` de-duplication so C3 cannot double count,
   and prefer `assigned_cashout_agent_id` over `processed_by` when both match different desks.
2. **Quarantine the unauthorised corrections.** Mark the 77 Bayo Mercy rows (and the 8 from
   `bwayo mark` / test accounts) as void for reporting purposes via a nullable
   `voided_at/voided_by/void_reason`, excluded from `adjustments_total`. No ledger effect; reversible.
   Requires a CFO sign-off list first — do not bulk-void without it.
3. **Reverse the duplicate 14 Aug reversal legs** (the `agent_float_deposit` cash_out
   `admin_correction` population, UGX 7,660,000 on these desks; ~32,810,000 platform-wide per the
   17 Aug report) with individually keyed compensating legs. Note the constraint in
   `mem://constraints/user-facing-ledger-filter`: an `admin_correction` **credit** is filtered out of
   `v_user_wallet_strict`, so a naive compensating credit will not move the displayed float. This must
   be posted as `production` with an explicit evidence reference, or the filter must be revisited
   deliberately.
4. **Author-and-self blocks + evidence gate** on `merchant_float_reconciliations`: drop `manager` from
   the insert policy, block `desk.agent_id = auth.uid()`, and require a provider reference (TID or
   `gmail_transactions` id), following the `merchant_payout_funding` evidence-gate pattern.
5. **Persist the clamp.** Write suppressed negative float to `wallet_overdraw_events` and surface
   `float_balance_signed` in the monitors so a desk that has overspent stops reading as healthy.

## 5. Reproduction

Every figure above comes from read-only SQL against `withdrawal_requests`, `general_ledger`,
`merchant_float_reconciliations`, `cashout_agents` and `profiles`, replicating
`get_merchant_float_positions()` verbatim at the 2026-08-01 anchor. Queries are inline in this
document's derivation and can be re-run without side effects.