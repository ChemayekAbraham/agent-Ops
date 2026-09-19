# Show statutory payroll obligations on the balance sheet

Today the "Taxes Payable" line on the Statement of Financial Position shows nothing, because the books have no tax account. Meanwhile payroll has genuinely withheld PAYE and NSSF from staff pay that has already been paid out. The statement is therefore understating what the company owes URA and NSSF.

## What the numbers are right now

Only payroll that has actually been paid creates an obligation (same principle already applied to staff advances — nothing is owed until money moves).

| Item | Amount |
| --- | --- |
| PAYE withheld from staff | UGX 7,072,000 |
| NSSF employee 5% withheld | UGX 1,440,000 |
| NSSF employer 10% contribution | UGX 2,880,000 |
| **Total owed to URA / NSSF** | **UGX 11,392,000** |

Payroll that is approved but not yet paid (a further UGX 32,647,500) is deliberately excluded until it is disbursed, and cancelled runs are excluded entirely.

## What will change

1. **A place to record payments to URA and NSSF.** A new remittance record: which authority, which payroll period, the amount, the date, the reference number, and who recorded it. Without this the obligation could never be cleared, only ever grow.
2. **A single trusted figure**, calculated on the server: statutory amounts withheld on paid payroll, less anything already remitted, broken down by authority (URA for PAYE and Local Service Tax, NSSF for employee and employer contributions).
3. **The balance sheet line comes alive.** "Taxes Payable" will show the real outstanding total instead of nothing, and tapping it opens the usual breakdown modal listing each authority and its exact amount — same layout as every other line.
4. **Clearly labelled as payroll-derived.** Because no tax account exists in the books, the modal will state that this figure comes from payroll records rather than the ledger, so it can never be mistaken for a posted ledger balance.

Nothing about how payroll is calculated, approved or paid changes, and no existing payroll or accounting record is altered.

## Technical notes

- Migration adds `hr_pay_statutory_remittances` (authority, period, amount, paid_on, reference, recorded_by, basis note) with GRANTs, RLS restricted to finance/leadership roles, and no DELETE policy — consistent with the rest of `hr_pay_*`.
- Migration adds `hr_pay_statutory_liability()` (SECURITY DEFINER, `SET search_path = public`, finance/leadership only) returning one row per authority component: withheld on runs with status `paid`/`locked`, minus remitted, plus the net outstanding.
- `src/components/cfo/balanceSheetClassification.ts` keeps `Taxes Payable` as a standalone liability category; `BalanceSheetPanel.tsx` fetches the RPC and feeds the line value plus its modal component lines, reusing the existing `ModalLine` / total rendering.
- Read-only on the ledger; no wallet or ledger writes; `npm run guard:all` before completion.
