# Financial System Reference Manual

Produce `docs/FINANCIAL_SYSTEM_ARCHITECTURE.md` — an exhaustive, read-only reverse-engineering of the money engine, written so a new CTO, auditor, or AI assistant can understand it without reading source code.

No code, SQL, migration, Edge Function, trigger, or config is touched. The only files created are the document and its diagram appendix.

## What the system actually looks like (measured, not assumed)

- `general_ledger`: 372,273 rows, 31 columns. Classifications present in real data: `production`, `legacy_real`, `test_dev`, `admin_correction`. The scope column is named `ledger_scope` (not `scope`).
- 480 tables, 1,074 database functions, 415 non-internal triggers in `public`.
- 285 Edge Function directories under `supabase/functions/`.
- 2,019 migration files.
- The cron catalogue is not readable with the current database grant (`permission denied for schema cron`). A `cron_jobs_health` function exists and will be the read path for section 13.

Because the inventories are this large, "exhaustive" is applied as **complete coverage of every finance-touching object, individually named**, with non-financial objects (HR tasks, listings, chat, SEO, campaigns) listed once in an exclusion appendix so the reader can see nothing was silently skipped.

## Document structure

One master document containing all 17 requested sections in the requested order. Mermaid diagrams live in `docs/diagrams/*.mmd` and are linked from section 15 so the master file stays navigable.

Every factual claim carries a reference — `file:line`, function name, trigger name, or table name. Anything not directly confirmed by a read is labelled **ASSUMPTION** inline. Where reads reveal a contradiction between code and data, both are stated and flagged as an open finding rather than resolved silently.

## What each section covers

1. **Executive summary** — money in / move / store / out, the double-entry guarantee, the sole source of truth, why caches exist, reconciliation and drift philosophy.
2. **Money flow map** — one subsection per flow: deposits, wallet topups, CFO direct credit and debit, standing orders, payroll, employee requisitions, merchant/landlord/agent float, rent collection and repayment, tenant and business advances, ROI credits and recoveries, commissions, referral and verification bonuses, merchant payouts, withdrawals, force reversals, wallet and error corrections, platform/debt/float recovery, scheduled payouts, auto-recoveries, supporter credits, investment returns, savings, payroll growth rewards. Each documents purpose, initiator, entry point, Edge Function, RPC, DB function, triggers, tables written, ledger legs, wallet buckets, destination, failure handling, idempotency, recovery, audit trail.
3. **Wallet architecture** — `withdrawable_balance`, `float_balance`, `advance_balance` plus pending/held/restricted concepts: ownership, who may modify, who may view, computation, protection, writer functions, caching tables.
4. **Ledger architecture** — double-entry rules, `ledger_scope` values, `transaction_group_id` grouping, the full category set actually present in data, `recipient_type` and `wallet_bucket` routing, cash-in/cash-out legs, platform vs wallet legs, corrections, reversals, settlements, recoveries, and how each group balances.
5. **Table inventory** — every finance table with purpose, primary key, relationships, writers, readers, triggers, RPCs, Edge Functions, business importance, and a classification of source-of-truth / projection / cache / snapshot / audit / config / legacy / deprecated.
6. **Edge Function inventory** — every finance function: purpose, caller, auth model, workflow, RPCs called, tables written, ledger and wallet interaction, error handling, idempotency, retry.
7. **RPC inventory** — every finance RPC: inputs, outputs, business rules, security (definer/invoker, `search_path`), side effects, ledger and wallet writes, triggers fired.
8. **Trigger inventory** — every finance trigger: purpose, table, rule enforced, risk if removed, risk if bypassed, known issues.
9. **Source-of-truth analysis** — the authoritative object, and a table sorting every other financial object into projection, cache, snapshot, materialization, temporary, obsolete, retirable, never-write-directly.
10. **Reconciliation** — the strict-wallet pivot, baseline and fresh-start anchors, drift detectors, repair jobs, cron cadence, alerting, recovery runbook.
11. **Security model** — role matrix across CFO, finance ops, manager, agent, merchant, supporter, tenant, employee; approval authority; service-role usage; RLS posture; SECURITY DEFINER inventory; anti-tampering guards.
12. **Failure modes** — each with cause, detection signal, impact, recovery, drawn from incidents already recorded in the repo and the database.
13. **Cron jobs** — schedule, RPC, tables, risk, failure behaviour, retry, read via the available health function.
14. **Financial reporting** — every wallet, ledger, CFO, agent, merchant, payroll, standing-order, recovery, commission, and audit report, with its data source.
15. **Diagrams** — Mermaid for overall money flow, wallet architecture, ledger architecture, deposit, withdrawal, standing orders, payroll, requisitions, merchant float, agent float, ROI, rent collection, recovery, approval workflow.
16. **Risk assessment** — strengths, weaknesses, technical debt, redundant components, unused tables, duplicate logic, security, operational, performance, scaling, maintainability risks.
17. **Appendices** — table / Edge Function / RPC / trigger dependency graphs, wallet bucket matrix, ledger category matrix, financial state machine, known assumptions, glossary, and the non-financial exclusion list.

## Method

Evidence comes from systematic introspection rather than recall: catalogue queries for functions, triggers, policies and foreign keys; category and classification aggregates over real ledger rows; and source reads of each flow's Edge Function and client entry point. Existing repo documents (`docs/partner-funding-and-agent-commission-investigation.md`, `docs/merchant-agent-payout-process.md`, the Self Portfolio Management series) and project memory rules are treated as inputs to re-verify, not as truth.

Research is parallelised across sub-agents by domain — ledger core, wallets and reconciliation, deposits and withdrawals, agent and float, payroll and HR money, supporter and ROI, crons and reporting — then merged into a single voice with a consistency pass so no section contradicts another.

## Expected size

Roughly 15,000-25,000 words plus 14 diagrams. This is a long single-purpose run, not a quick edit.