# 257 — Move Nakitende Jumeirah's unrecovered receivable onto Gven's advance

**Date:** 2026-11-05 · **Decision:** CTO + CFO, "Option A: Gven must carry it" · **Status:** **APPLIED LIVE 2026-11-05 07:29 UTC (run by the CTO under the CFO id), VERIFIED.**

## Why
Doc 254 closed plan `406ed7bc` and waived the tenant's balance but posted no ledger legs, so about 332,000 stayed in A3 (400,000 created - 64,000 restated - 4,000 collected) with nobody owing it. The 28 Oct top-up (`bdf7dc99`, 300,000, Mercy) paid Gven cash and did not touch the tenant side; its reason reads "Used for Emmergency". Gven's earlier 16 Oct advance (300,000, Sarah) is unrelated.

## What the migration does
`supabase/migrations/20261105120000_reclass_nakitende_shortfall_to_gven_advance.sql`, run as Sarah Angwen (CFO):
- advance `d0c44c3c` outstanding +332,000 (statement row via the balance-adjustment note);
- one balanced platform group: DR A10 `agent_advance_disbursement` / CR A3 `tenant_repayment`, 332,000, no wallet effect, idempotency key `reclass_shortfall_to_advance:<plan>`;
- audit row `rent_plan_shortfall_reclassed_to_agent_advance`.
Guards: CFO role, plan completed + waived against this agent/advance (from the doc 254 audit row), advance open, A3 exactly 332,000, idempotent.

## Dry run (2026-11-05, rolled back, verified nothing kept)
Legs resolved A3 cr 332,000 / A10 dr 332,000. Advance 495,060 -> 827,060; statement row +332,000 `balance_adjustment`; daily instalment and expiry unchanged (16,417 / 2026-12-15); plan `amount_repaid` unchanged at 216,000.

## Found while testing
Tenant Ops transferred the plan to SHAFEEQ SSENABULYA on 11-02 and 11-03, so `rent_requests.agent_id` is no longer Gven. The first dry run stopped on that guard. The responsible agent is now proven from the doc 254 waiver audit row (`metadata.agent_id`).

## Verified after running
Advance `d0c44c3c`: outstanding 495,060 -> 827,060, expires 2026-12-15 -> 2026-12-27, cycle_days 60 -> 72, daily instalment 16,417, status active, arrears 0. Statement row +332,000 `balance_adjustment`. Audit row `rent_plan_shortfall_reclassed_to_agent_advance` under Sarah's id (amount 332,000). Plan A3 balance on the resolved ledger 332,000 -> 0.00; plan still `completed`, `amount_repaid` 216,000.

## Repayment terms (CFO decision 2026-11-05: extend the expiry)
The daily instalment stays 16,417. The migration extends `expires_at` and `cycle_days` so the instalment clears the new balance: days needed = ceil(827,060 / 16,417) + 1 = 52 from the run date; the expiry only moves later. Dry run on 2026-11-05: expires 2026-12-15 -> 2026-12-27, cycle_days 60 -> 72, status stays active, arrears 0. Re-running on a later day moves the new expiry later by the same number of days.

## Still open
1. Gven should be told; the migration sends no notification.
2. The 16 Oct advance shows a 300,000 "collected before withdrawal" wallet debit that the advance statement never recorded — separate reconciliation issue, not touched here.
