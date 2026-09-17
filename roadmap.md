# Roadmap

- [x] National ID capture: require straight landscape front/back photos; reject 90°/-90° before OCR or submission.
- [x] Add a Financial Ops sidebar section for manual requisition links and management.
- [x] Route public manual requisition submissions through COO review, then CFO final approval.
- [x] Preserve the existing My Space requisition path and validate with guards/build.
- [ ] Daily comprehensive report email: attached PDF must be the report HTML rendered as-is (no redesigned PDF layout).
- [x] WELILE-CC-TICKETFIX24: hr_tickets external-origin constraint fix (origin internal, length guards), 20-char note guard in cc_record_engaged + client-side counter, cc_call_cycles.wip_limit (default 10) driving guard + UI, repair parked rows without tickets.
- [x] WELILE-CC-WIPUI26: open-attempt badge/guard read cc_call_cycles.wip_limit only; no client fallback number; reveals stay enabled while the limit is loading.
- [x] Fix typecheck build errors in AgentOpsReportWindow.tsx (`periodStart` narrowing on `AgentOpsReportWindowResult`).

- [x] Renewal rent requests: agreement optional end-to-end (trigger bypass + client gates removed for renewal/outstanding).
- [x] CapitalRoutesSection: mobile hero top space matches space below the CTA button.
- [x] Payroll: add ARREARS salary component (scope-fenced migration).
- [ ] Fix AgentRentRequestDialog typecheck syntax error and verify preview build.
- [x] CapitalRoutesSection hero: desktop heading wraps within container (no nowrap overflow).
- [x] SelfPortfolioFundingCard: default feed order Houses first; toggle reordered accordingly.
- [x] Tenant "Kyeyune Agibu": cleared orphaned self-support reservation so CFO landlord-float disbursement is eligible; no money moved.
- [x] Fix preview typecheck errors in AgentOpsApprovedRequestsPanel.tsx and RentPipelineQueue.tsx.
- [x] Partner Ops overview: Returns projection card at 50% width with a self-supported vs company-supported portfolio doughnut beside it.
- [x] Scope fence 7: four verbatim edits to src/hr/pay/PayRuns.tsx (ArrearsPanel wiring).
- [x] Match the top-up PDF to the uploaded reference and send a UGX 50,000 test email for portfolio WSP-8102.
- [ ] Fix preview build errors from /tmp/observability/build-errors.log (Supabase edge function TypeScript errors).

- [x] Agent Ops comprehensive daily report: attach a real PDF (jsPDF builder) instead of raw HTML, with validation and hard-fail behaviour.
- [ ] TRACE-01 (read-only): measure v_rent_repaid_reconciliation unexplained_credit exceptions (6 SELECTs, no writes).
- [ ] Send Money "General Payout Activity": add a custom filter (approver/recipient search + amount range).
- [x] CFO Money We Owe drilldown: paginated/infinite-scroll transfer lists.
- [x] CFO Money We Can Use: expandable transaction-level breakdown of Money We Have vs Money We Owe, incl. excluded flagged transfers.

- [x] Assign self-onboarded Rent Requests to the authenticated tenant’s verified referring agent.
- [x] Cash Deposit Codes: show the latest SMS/email code-delivery channel in the list and details.
- [x] Redesign Verify Payout Numbers panel to focus-mode (Split-Screen Focus v2 direction, Welile purple, Outfit/Figtree).
- [x] Add accessible labels/ARIA to verification-history photo viewer controls (position, resolution mode, shortcuts announced).

- [x] Add the same live summary to Other contributors.
- [x] Update Tenant Products & Services options and consistent zero-state projections.

- [ ] Smartphone amounts framed as Welile down payment (Mo Banja balance paid separately) across Agent Ops + Agent dashboards; wording only.
- [ ] Agent Ops-stage rejected requests reopenable by managers (existing reopen workflow, required reason).
- [ ] Stale/expired returns should not consume the agent reopen allowance.
- [ ] Show agent remaining resubmission attempts before submitting.
- [x] Verify payout: back of National ID no longer required (no capture UI exists).
- [x] Stop sending email to placeholder phone-only addresses (central guard + queue skip).

- [ ] Cash & Bank (A1) correction: show exact journal entries + before/after balances for approval, then implement float reclass (A8/X6), verified banked-cash posting, and split Cash at Bank / Agent Float / Cash in Custody presentation.
