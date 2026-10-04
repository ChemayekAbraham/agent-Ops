# Financial Operations Architecture Manual

Produce one new read-only document, `docs/FINANCIAL_OPERATIONS_ARCHITECTURE.md`, covering all 19 requested sections. No code, SQL, migrations, Edge Functions, triggers, config or business rules are touched.

This follows the same method already used for `docs/FINANCIAL_SYSTEM_ARCHITECTURE.md`, `docs/AGENT_SYSTEM_ARCHITECTURE.md` and `docs/SUPPORTER_SYSTEM_ARCHITECTURE.md`: reverse-engineer from the live database and the actual source, then label every statement as **Observed**, **Reported** (stated in-repo but not independently verifiable — mainly `pg_cron`, which the audit role cannot read) or **Inference**.

## What the module actually is

Initial scoping reads confirm the FinOps surface is large and split across two role families:

- `src/components/financial-ops/` — 70 files. The Financial Operations Command Center: wallet moves, bucket transfers, deposit verification, email auto-match, landlord payout queues, bulk bank payouts, reconciliation dashboards, employee requisition queues, daily wallet reports.
- `src/components/cfo/` — 60+ files. CFO-side controls: Direct Credit tool, float management, advances, allocation traces, receivables, daily cash position, cron health, phantom drift.
- `supabase/functions/` — 285 functions in total, of which roughly 75 are finance-related (`cfo-direct-credit`, `finops-wallet-move`, `approve-wallet-operation`, `process-scheduled-payouts`, `requisition-decide`, `landlord-payout-disburse`, `admin-float-to-withdrawable`, `process-debt-recovery`, `wallet-cache-sweep`, `sweep-payout-debits`, and more).

The separation of powers between CFO (inbound, strategic, approval) and FinOps (outbound, verification) is a first-class architectural boundary and will be documented as such.

## Research approach

Six parallel read-only investigation passes, each producing a findings report that is then synthesised into the final document:

1. **Operations catalogue** — every FinOps operation end to end: Direct Credit/Debit, wallet-to-wallet corrections, recover-to-platform, split debit, force reversals, mark-not-funded, treasury operations. Business owner, initiator, approver, entry point, function, tables, ledger legs, buckets, audit trail, rollback, idempotency.
2. **Float management** — the distinct floats (operational, agent, agent-landlord/LP, merchant) plus top-ups, recoveries, reconciliation and the bucket-transfer paths.
3. **Payroll, requisitions and standing orders** — `hr-pay-release`, `requisition-decide`, `process-scheduled-payouts`, the `system_requisition_credit` mechanism, failed-credit recovery, debt collection.
4. **Ledger, wallet and reconciliation internals** — `create_ledger_transaction`, `apply_wallet_movement`, `recipient_type` routing, the balances projection, strict wallet reads, baselines, fresh-start anchors, and every drift view and repair job that actually exists in the database.
5. **Security and approval model** — role hierarchy, RLS inventory across finance tables, SECURITY DEFINER catalogue, session flags, trigger guards, anti-tampering, approval matrices.
6. **Dashboards, reporting and failure modes** — every screen and its data source, every report, plus quantified failure evidence from the correction, violation, alert and drift tables.

## Document structure

All 19 sections as specified, in the requested order: executive summary; complete business model; money movement map; table inventory (each table classified as source of truth / projection / cache / audit / configuration / queue / legacy / deprecated); Edge Function inventory; RPC inventory; trigger inventory; wallet interaction; ledger interaction; approval workflows; security model; reconciliation engine; failure modes; cron jobs; reporting; dashboard architecture; end-to-end workflow diagrams; risk assessment; appendices.

Section 17 carries Mermaid diagrams for all fourteen named flows, embedded as fenced `mermaid` blocks in the markdown.

Section 18 ranks findings — strengths, technical debt, duplicate logic, unused tables and functions, security risks, bottlenecks, single points of failure — each with a concrete remediation note, in the same style as the gap registers in the previous three manuals.

Section 19 appendices: table dependency graph, Edge Function graph, RPC graph, trigger graph, wallet interaction matrix, ledger category matrix (built from live `general_ledger` aggregates rather than assumed names), approval matrix, financial capability matrix, state machine diagrams, business rule catalogue, glossary.

## Technical notes

- Database inspection is read-only `SELECT` against `pg_policies`, `pg_proc`, `pg_trigger`, `pg_views`, `information_schema` and `general_ledger` aggregates.
- `cron.job` is permission-denied to the audit role, so the cron section separates what is observable in migrations from what is only documented in-repo, and flags any finance job whose schedule cannot be confirmed.
- Where in-repo comments contradict the live code (this already surfaced in `approve-deposit`, where a documented "withdrawable by default" contract is unreachable), the document records the contradiction rather than repeating the comment.
- Expected length is comparable to the existing manuals — roughly 1,000 lines.