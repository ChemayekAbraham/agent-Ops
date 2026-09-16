# Fix the Cash Flow Statement so it reconciles to the Balance Sheet

## What the audit found (read-only, production data)

**Root cause 1 — the Cash Flow resolves ledger legs with its own, simpler rules than the Balance Sheet.**

The Balance Sheet reads every ledger leg through one resolver (`sofp_ledger_legs`), which applies
the agreed reclassification rules: agent-float restatements go to Float Restatement Adjustments,
float issue/settlement goes to the Float Cycle Control account, write-off patterns go to Credit
Losses, and one-sided historic postings get an explicit counterpart.

The Cash Flow function does **not** use that resolver. It re-implements only the raw default
mapping, so every wallet float leg lands in "Cash at Hand — Float with Agents" and no
reclassification is applied. Measured on production, cash to date:

| Cash account | Cash Flow today | Balance Sheet | Difference |
| --- | --- | --- | --- |
| A1 Cash at Bank | 997,583,193 | 1,123,199,080 | 125,615,887 |
| A2 Agent float (cash at hand) | 46,572,054,983 | 131,486,678 | 46,440,568,305 |
| **Closing cash** | **47,569,638,176** | **1,254,685,758** | **46,314,952,418** |

**Root cause 2 — the float cycle and cash-in-transit accounts have no mapping rows**, so their
movements fall into "Other Operating Activities → Unclassified ledger movements". Unmapped
counterpart movements to date:

| Account | Category | Cash effect |
| --- | --- | --- |
| A8 Float Cycle Control | agent_float_deposit | 50,229,283,829 |
| A8 | system_balance_correction | (46,694,779,765) |
| A8 | agent_float_settlement | (1,674,071,738) |
| A8 | agent_float_cycle_settled_to_bank | 287,259,444 |
| A8 | agent_float_funding / assignment / topup | 31,851,075 |
| A5 Cash in Transit | cash_receipt_in_transit | (537,981,342) |
| A5 | cash_in_transit_banked | 171,420,000 |
| X6 Float Restatement | system_balance_correction | (189,940,717) |
| A6 Landlord receivables | landlord_receivable_collected | 250,000 |

Everything else already maps to a named line.

## What needs to change

Reporting and mapping only. No ledger entries, no historical data, no tenant repayment or
Treasury logic, no plugs.

1. **`sofp_ledger_legs`** — add a `transaction_date` column to what it returns. The Cash Flow
   needs dates to split opening/period/closing; the resolver currently returns none. The rules
   themselves are untouched, so the Balance Sheet produces identical figures.
2. **`get_statement_of_cash_flows`** — delete its private mapping block and read legs from
   `sofp_ledger_legs(p_to)` instead. Cash stays defined as the Balance Sheet's two cash accounts
   (A1 Cash at Bank + A2 cash at hand with agents), each at its signed trial-balance value.
   Cash in Transit (A5, 655m) stays outside cash — exactly as the Balance Sheet presents it — and
   appears as a classified counterpart line, not as cash.
3. **`cash_flow_line_map`** — add rows for the accounts above so the genuine cash movements are
   named and the float cycle and correction movements are disclosed on their own lines instead of
   being lumped into "Unclassified":
   - Agent and Merchant Float Cycle group: float issued to agents, float settled back, float
     banked, float restatements.
   - Cash received not yet banked, and cash in transit subsequently banked.
   - Landlord receivable collections onto the existing landlord line.

## Verification before reporting back

- Opening + net movement = closing cash, exactly.
- Closing cash equals the Balance Sheet's cash accounts, exactly.
- "Unclassified ledger movements" reduced to zero, or every remaining shilling itemised.
- Balance Sheet figures unchanged before and after (same numbers on every account).
- Statement re-read as CFO in the running app.

## Out of scope

Historical ledger entries and balances, the 184 banking declarations, the tenant-payment posting,
Treasury logic, the Income Statement, and the Equity email parser.
