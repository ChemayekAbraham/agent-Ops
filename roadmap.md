# Roadmap

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
