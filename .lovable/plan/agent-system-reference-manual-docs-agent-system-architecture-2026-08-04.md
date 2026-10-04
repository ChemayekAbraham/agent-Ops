# Agent System Reference Manual — docs/AGENT_SYSTEM_ARCHITECTURE.md

Read-only reverse-engineering of the entire Agent Module, delivered as one exhaustive Markdown manual plus Mermaid workflow diagrams. No code, SQL, migration, Edge Function, trigger, or business-rule changes.

## What already exists to build on

`docs/FINANCIAL_SYSTEM_ARCHITECTURE.md` (written last turn) covers ledger and wallet mechanics. The Agent manual will reference it rather than duplicate it, and go much deeper on agent-specific behaviour.

## Verified starting surface

- **74 agent-adjacent tables and views** confirmed live, including `agent_advances`, `agent_collections`, `agent_subagents`, `agent_capabilities`, `agent_landlord_float`, `agent_landlord_float_allocations`, `agent_float_limits`, `agent_float_withdrawals`, `agent_earnings`, `agent_commission_payouts`, `commission_accrual_ledger`, `cashout_agents`, `merchant_agent_referrals`, `agent_daily_eligibility_history`, `v_agent_daily_eligibility`, `vw_agent_ops_directory`, the `agent_capability_ops_*` job/batch/undo/dead-letter set, `subagent_tenant_transfers`, and `agent_tier_capabilities`.
- **~48 agent-related Edge Functions** confirmed, including `agent-deposit`, `agent-withdrawal`, `assign-agent-float`, `fund-agent-landlord-float`, `transfer-to-float`, `agent-cash-deposit-create/confirm/resend`, `post-float-payout-commission`, `generate-daily-merchant-commission`, `process-agent-advance-deductions`, `voluntary-repay-advance`, `disburse-business-advance`, the sub-agent invite set, `notify-agent-frozen`, and `agent-ops-daily-report`.
- **Agent UI surface** confirmed: `src/components/agent/` (100+ components) and `src/pages/agent/` (Cash Payouts, Float Breakdown, Leaderboard, Merchant Transaction History, Payout Receipt History), plus the Agent Hub and Service Center.

## Investigation method

Parallel read-only research agents, each producing one evidence-backed part of the manual:

1. **Identity, lifecycle and types** — `agent_capabilities`, `agent_tier_capabilities`, `agent_subagents`, `sub_agent_registration_drafts`, `agent_relationships`, `proxy_agent_assignments`, `financial_agents`, the `agent_tier` enum, and the verification / freeze / suspension paths.
2. **Money earned** — commission accrual versus release, recruiter overrides, verification bonuses, placement bounty, merchant commission, incentives, payroll, and the exact ledger legs and wallet bucket for each.
3. **Float and tenant operations** — agent float, landlord-payout float, allocations, corrections, reversals, unfunding and return requests, tenant assignment / transfer / reassignment, collections, and the daily capacity model.
4. **Credit, merchant ops and controls** — agent advances (limits, top-ups, installments, arrears), business advances, cashout dispatch and claiming, merchant payouts, fraud and freeze gates, withdrawal caps, RLS and trigger guards.
5. **Automation and failure surface** — every cron job touching agents, plus each documented failure mode with cause, detection, impact and recovery.

Every structural claim is verified against the live database (`pg_proc`, `pg_trigger`, `pg_policies`, cron registry) and the checked-in source. Facts and assumptions are labelled distinctly.

## Deliverable structure

All 22 requested sections in order: Executive Summary, Business Model, Lifecycle, Agent Types, Table Inventory (each table classified as Source of Truth / Projection / Cache / Audit / Configuration / Legacy / Deprecated), Edge Function Inventory, RPC Inventory, Tenant Management, Float Management, Commission Engine, Advance System, Merchant Operations, Wallet Interaction, Ledger Interaction, Dashboard Architecture, Performance Engine, Security Model, Failure Modes, Cron Jobs, End-to-End Workflow Diagrams, Risk Assessment, Appendices (dependency graphs, permission / dashboard / financial capability matrices, state machines, business-rule catalogue, glossary).

## Technical notes

- Output file: `docs/AGENT_SYSTEM_ARCHITECTURE.md`, one document, expected to be long — comparable to or larger than the financial manual.
- The 16 requested Mermaid diagrams are embedded in Section 20 as fenced `mermaid` blocks, with the agent lifecycle state machine repeated in the appendices.
- Divergences between the live database and migration history are recorded explicitly rather than silently resolved.
- Every table, function, trigger and source file is referenced by exact name so each claim is traceable.