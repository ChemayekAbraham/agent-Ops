---
name: Self-support portfolio Phase 3 hardening
description: Phase 3 hardening of partner self-support rent-plan funding — no self-approval, float-only debit, cancelled-line release, idempotency retirement, accurate single-approval float SMS
type: feature
---
# Self-support (rent plans) — Phase 3 hardening, completed 2026-09-01

Baseline for the upcoming Phase 4 (empty-house plan flow). Everything below is the
locked behaviour for the **rent-plan** self-support path.

1. **No self-approval.** `funder_support_tenant_direct` stops at
   `pending_ops_approval` with a genuinely `pending` vetting row. Sufficient balance
   is never approval. Debit, landlord-float release, SMS and email happen only inside
   `approve_pending_portfolio` / Partner Ops approval.
2. **Float-only debit.** Principal draws from `float_balance` via
   `funder_float_available`. `approve-pending-portfolio` edge fn MUST skip its generic
   `portfolio-funding-<id>` withdrawable pre-debit for sources `self_managed` and
   `self_managed_house` (double-charge bug, hit WSH-9681).
3. **No orphaned funded tenants.** `psm_release_self_funding_line` releases the plan
   and reverses float allocations when a line is cancelled; trigger
   `trg_psm_release_plan_on_line_cancel` enforces it going forward;
   `psm_release_orphaned_self_funding` repairs history; the
   `funder_supported_tenants` view filters cancelled lines.
4. **Idempotency retirement on resubmit.** Deterministic keys (user + plan ids) made
   resubmission after a cancel a silent no-op. `psm_release_cancelled_idempotency`
   retires keys of cancelled/reverted commitments and is called first inside
   `funder_support_tenant_direct`, so a resubmit always creates a fresh vetting row.
5. **Accurate approval SMS.** `psm_disburse_landlord_float` aggregates only the
   allocations created in that approval (excludes cancelled/reversed) — previously it
   summed every allocation ever attached and announced inflated amounts/tenant counts.
   `notify-partner-float-agents` fails over to Africa's Talking only when Yoola
   actually rejects; accepted-but-unconfirmed is logged, never re-sent.
6. **UI.** `SelfPortfolioDeployDialog` defaults to "Support this Tenant now"
   (Recommended) when no active portfolio exists; "Start a new monthly portfolio" is
   hidden unless balance is insufficient. Success toast reads
   "Submitted — pending approval".

Known Phase 4 gap: `funder_pending_portfolios.source = 'self_managed_house_topup'`
still falls into the generic ELSE branch of `approve_pending_portfolio` (withdrawable
leg, `psh-commit-` key replays) — to be fixed in the empty-house hardening flow.
