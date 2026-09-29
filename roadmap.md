- [x] Reconcile current production Income Statement totals before presentation changes.
- [x] Build the comparative management P&L table using existing account labels and calculations.
- [x] Align CSV and PDF exports with Current, Previous, Change, and Change %.
- [x] Verify calculations, safeguards, and desktop/mobile presentation.

## Pending
- [x] CI: map load-test budgets run in build workflow and block deploy on regression (done 2026-09-21)

- [x] Show the current landlord number on file in the agent payout flow and block OTP when it differs from the Ops-approved number.

- [x] Reporting-side correction: float ⇄ withdrawable movements report as customer custody (L1) with X4 counterpart (2026-09-23)
- [ ] Partner float funding (UGX 368,320,964) still reported as customer custody — needs a designed counterpart, blocked on CFO ruling
- [x] "How it works" moved out of the funder hero into its own row below the map (2026-09-23)
- [x] Repair lending-agent daily arrears recovery and borrower alerts/email; deploy and verify Enock's advance.

- [x] Reconcile EMP-00053 September collected notes and correct the report source/count.
- [x] Improve the concerns page for smartphone navigation with prominent Call and WhatsApp actions.

## Added 2026-09-29
- [ ] Read-only dry run: trace real repayments through proposed holding and four-part final destinations.
- [ ] Verify no duplicate Commission, Partner Returns, Platform Fee revenue, or landlord obligation.
- [ ] Design immutable payment identity, exactly-once settlement, and full reversal safeguards.
- [x] Improve wallet transfer confirmation so amount and confirm action remain visible above the mobile keyboard.
- [x] Standardize unauthorized Requisition Approve messages without changing permissions or financial behavior.
- [x] Label every send-item picture with “Welile” and make the swipe picker the only item-selection method.
- [x] Add a dedicated CFO Cash Position page below Home; the section now shows only there, removed from Home.
- [x] Move the Cash Movement section (Today's Money Flow + 7-day chart) off Home onto the Cash Position page, like General Payout Activities.
- [x] Remove the Tools & Audit Trail section from CFO Home (receipt lookup, email transactions, transaction search, CFO actions log).
- [x] Redesign CFO Cash Position to match the supplied clean 4-by-2 financial overview while preserving live logic and drill-downs.

- [x] Redesign the CFO Cash Position payout report as a unified professional report, preserving live figures, controls, export, and pagination.
- [x] Add next/past 7-day receivable windows on each receivable page; next 7 days is predicted (ideal + behaviour), past 7 days shows ideal only.
- [x] Add a Past 7 Days & Next 7 Days section to CFO Home for receivables and payables; selecting a day drills into the products and services behind it, without listing individual people.
