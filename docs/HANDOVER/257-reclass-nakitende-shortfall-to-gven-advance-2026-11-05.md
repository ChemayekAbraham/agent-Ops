# 257 — Move Nakitende Jumeirah's unrecovered receivable onto Gven's advance

**Date:** 2026-11-05 · **Decision:** CTO + CFO, "Option A: Gven must carry it" · **Status:** migration written, dry-run PASSED (rolled back), **NOT RUN** — waiting for the CFO's repayment-terms decision.

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

## Open decisions (CFO)
1. At 16,417/day the 827,060 balance cannot clear by the 2026-12-15 expiry: extend `expires_at` / raise the instalment, or accept the overdue penalty (0.8263%/day).
2. Gven should be told; the migration sends no notification.
3. The 16 Oct advance shows a 300,000 "collected before withdrawal" wallet debit that the advance statement never recorded — separate reconciliation issue, not touched here.
