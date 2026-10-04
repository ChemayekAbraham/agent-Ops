# CFO Operations & Financial Governance Manual

Produce one new read-only deliverable: `docs/CFO_SYSTEM_ARCHITECTURE.md`. No code, SQL, migration, config, or business-rule changes; no financial mutations.

## Scope confirmed by initial reads

- 93 components under `src/components/cfo/`, plus CFO pages `Dashboard`, `InvestorReportPage`, `LedgerEntryDetail`, `MoneyFlowTrace`, `PhantomDriftDetail`.
- Payroll surface under `src/hr/pay/` (incl. `CfoPayrollPanel.tsx`, `PayRuns`, `Approvals`, `api/`, `calculator/`).
- ~65 candidate Edge Functions touching CFO duties (e.g. `cfo-direct-credit`, `approve-wallet-operation`, `requisition-decide`, `requisition-credit-retry`, `process-scheduled-payouts`, `hr-submit-payroll`, `finops-wallet-move`, `process-debt-recovery`, `wallet-cache-sweep`, and the float / landlord-payout family).
- Role wiring lives in `src/components/layout/executiveSidebarConfig.ts` (`cfo` nav group, `/cfo/dashboard` home).

## Method

1. Parallel read-only investigation passes over: CFO UI surface, Edge Functions, RPCs, triggers, tables, cron jobs, RLS/grants.
2. Database introspection via read queries only: `pg_proc` bodies for CFO RPCs, `pg_trigger` on `general_ledger` / `wallets` / requisition / payroll tables, `cron.job` schedules and last-run status, `pg_policies` plus table grants for every CFO table.
3. Cross-check each claim against the actual implementation; label anything not directly verified as an assumption.
4. Reuse verified material from the existing FinOps, Agent, Supporter, and Financial System architecture docs where the CFO module overlaps, re-verifying before restating.

## Deliverable structure

The document follows the 19 requested sections exactly:

1. Executive summary (purpose, authority, governance model)
2. CFO responsibilities (purpose / owner / approval authority / financial impact / dependencies)
3. Complete CFO workflow map
4. Financial approval engine
5. Database table inventory (classified: source of truth, projection, audit, queue, config, cache, legacy, deprecated)
6. Edge Function inventory (auth, authz, RPCs, tables, wallet/ledger effects, idempotency, retries)
7. RPC inventory
8. Wallet governance (withdrawable / float / advance buckets, recoveries, overdraft, debt)
9. Ledger governance (scopes, categories, transaction groups, double-entry legs, routing)
10. Treasury management
11. Reconciliation engine (strict wallet, pivot view, baselines, drift detection, repair jobs, alerts)
12. Dashboard architecture
13. Reporting engine
14. Security model (roles, SECURITY DEFINER, RLS, trigger protections, anti-tampering)
15. Failure modes (cause / detection / impact / recovery)
16. Cron jobs (schedule, RPC, tables, retry, failure behaviour, active vs stale)
17. Mermaid diagrams for all 14 requested flows
18. Risk assessment (strengths, debt, duplication, dead code, security / operational / performance / scalability risks, single points of failure)
19. Appendices (dependency graphs, approval matrix, financial authority matrix, wallet capability matrix, ledger category matrix, state machines, business rule catalogue, glossary)

Every section cites concrete file paths, function names, trigger names, table names, and cron job names. A ranked gap register closes section 18, with facts and assumptions clearly separated.

## Notes

- Any security issues discovered are documented only, not fixed, unless you ask separately.
- Expect a long document; it is written in one pass after the investigation completes.