- [x] Reconcile current production Income Statement totals before presentation changes.
- [x] Build the comparative management P&L table using existing account labels and calculations.
- [x] Align CSV and PDF exports with Current, Previous, Change, and Change %.
- [x] Verify calculations, safeguards, and desktop/mobile presentation.

## Pending
- [x] Make Agent Ops open on 14 business-area panels; preserve existing sections in a collapsible side menu and mobile sections menu.
- [x] Show the unique number of users who have sent wallet-to-wallet transfers on the Agent Ops Shopping Advance page, including historical transfers.
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
- [x] 7-day cards on CFO Home count every qualifying receivable/payable record (no top-100 cap); undated wallet balances stay out of dated buckets.
- [x] Rename "Next 7 Days (Prediction)" to "Next 7 Days" and make every 7-day day label/bucket a Kampala (EAT) calendar day, matching the server.

## Added 2026-10-01
- [x] ENGREP-LIVENESS-SWEEP-01: migration 0375 — engrep_reevaluate_liveness_recent + cron job 40897 re-pointed to 7-day sweep.
- [x] Josh Wanda push d5389c19 (useUserSnapshot IndexedDB fix): apply any unlanded migrations (0372/0373/0374) and publish the frontend; nothing else.
- [x] Make the Welile Shopping Advance tile on the Agent Ops home attention-seeking (filled primary + breathing outline); no routing change.
- [x] Atimango Joyce balance check (read-only): UGX 6,350,000 verified; open plans match payments; first plan carries an unbacked UGX 500,000 paid-amount edit from 23 Jul.
- [x] Replace CFO payout “Select All” checkbox with a review-first bulk payment button; selection remains read-only until explicit final confirmation.
- [x] Add a complete read-only Shopping Advance user dossier with Rent Plans, advances, obligations, partnerships, shares, and AI ID details.
- [x] ROI Payment Queue: mirror Rent Payout Queue bulk select + review + Confirm & Pay Selected (no payment until confirm)
- [x] Narrow the single rent disbursement review card and the bulk payment review card so the wide centre-sheet defaults no longer stretch them on large screens; selection/review still sends no payment.
- [ ] Shopping Advance: GPS location gate for users with no location (blocked on user answers)

## Added 2026-10-02
- [x] Close Lillian Nabwire portfolio WIP2604024329 as redeemed today (no email) and credit UGX 9,818,988 to her withdrawable wallet.
- [x] Add drill-down breakdown to CFO "Withdrawable credits today" window.
- [ ] Credit Lillian Nabwire UGX 9,818,988 to withdrawable wallet — blocked: needs CFO to post via CFO Direct Credit (no approved principal-return ledger path).
- [x] Redesign /rd page from reference image (Namatovu Gloria)
- [x] CFO Cash Position: replace Cash Movement with screenshot layout
- [x] CFO Cash Position: add a decision-focused liquidity brief, refresh control, reconciliation status, and professional page hierarchy.
- [x] R&D page: apply format from user's screenshot (Namatovu Gloria)
