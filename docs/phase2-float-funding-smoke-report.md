# Phase 2 — Operational-float funding: conversion, smoke tests, and fixes

Date: 2026-09-01
Subject partner: **SSENKAALI PIUS** (`0b109aad-212a-4fd0-ab03-3d7aee9cf397`)

---

## 1. Balance conversion (applied, live)

His whole withdrawable balance was reclassified into operational float through the
ledger — no direct wallet write, no new money created.

| | Before | After |
|---|---|---|
| Withdrawable | UGX 737,300 | UGX 0 |
| Operational float | UGX 0 | UGX 737,300 |
| Wallet total | UGX 737,300 | UGX 737,300 |

Ledger pair (`transaction_group_id 3c4c316e-f643-44dc-be4e-b29d9c40231c`,
`reference_id WDR2FLT-PIUS-20260901`, idempotency key `wdr2flt-<uid>-phase2`):

```
bucket_reclass_out / cash_out / wallet / withdrawable / 737,300  (recipient_type=user)
bucket_reclass_in  / cash_in  / wallet / float        / 737,300  (recipient_type=operational_wallet)
```

Both legs carry `float_usage=self_portfolio_funding; withdrawable_to_float_conversion`
in the description, plus an `audit_logs` row with a written basis. The idempotency key
makes a repeat run a no-op.

## 2. Code changes made in this phase

1. **`funder_create_pending_portfolio`** — an *ordinary* funder portfolio now gates on
   `funder_float_available` (operational float, already net of portfolios awaiting
   approval) instead of the withdrawable balance. Error copy and the returned
   `available_balance` now speak of operational float, and the audit row records
   `funding_source=operational_float`.
2. **`approve_pending_portfolio`** (rent-pool / Partner-Ops branch) — the wallet leg is
   now `recipient_type=operational_wallet`, `wallet_bucket=float`, tagged
   `float_usage=portfolio_funding`.
3. **`enforce_portfolio_funding_at_creation`** (portfolios that go live immediately, e.g.
   Partner Ops creating one directly) — same float routing and tag.
4. **`partner_ops_approve_self_topup`** — the platform leg description was missing the
   audit tag; it now carries `float_usage=self_portfolio_funding` like its wallet leg.
5. **New `funder_float_capacity(uuid)`** — one internal definition of deployable float,
   `EXECUTE` revoked from `anon`/`authenticated`, so every gate reads the same number in
   a single round trip (no per-row balance recomputation, no N+1).
6. **New edge function `notify-self-topup-approved`** + wiring in
   `SelfManagedTopUpReviews.tsx` — top-up approvals sent SMS to agents but never a
   partner confirmation email. It now dispatches `partner-self-managed-deployment` with
   idempotency key `partner-self-managed-topup-<topup_id>`, batching the tenant lookup
   into one query. Fire-and-forget: an email failure can never reverse an approval.

## 3. Smoke tests

Every flow was rehearsed against production data inside a transaction that was
**rolled back** — Pius's wallet is back at float 737,300 / withdrawable 0, and no
rehearsal portfolios, claims or ledger rows remain (verified after the run).

| Flow | Result | Float movement | Ledger |
|---|---|---|---|
| Self-support with rent plans (`psm_confirm_commitment_for` → Partner Ops approval) | PASS | 737,300 → 587,300 (150,000) | `supporter_rent_fund/cash_out/wallet/**float**` + `partner_funding/cash_in/platform`, then `rent_disbursement` → `rent_receivable_created` (bridge) |
| Self-support with rent plans **and** empty houses (`partner_support_houses`) | PASS | 587,300 → 237,300 (350,000) | same shape; commitment created `pending_ops_approval`, debit only at approval |
| Funder creates an ordinary portfolio (`funder_create_pending_portfolio` + approval) | PASS | −50,000 from float | `partner_funding/cash_out/wallet/**float**` + `partner_funding/cash_in/platform` |
| Partner Operations creates a portfolio (creation trigger) | PASS | −40,000 from float | `partner_funding/cash_out/wallet/**float**` + platform credit |
| Partner Operations tops up a portfolio (`partner_self_top_up` → approval) | PASS | 587,300 → 437,300 (150,000) | `supporter_rent_fund/cash_out/wallet/**float**` + platform credit + release legs |

Checks that passed alongside:

- **No duplicates** — zero idempotency keys mapping to more than one transaction group,
  and exactly **one** wallet leg per deployment (no double debit at both commitment and
  approval; commitment only reserves, approval debits).
- **Balanced and traceable** — every deployment is a balanced pair whose wallet leg names
  `float_usage=…`, so float spend can be reconciled back to the funded plan/portfolio as
  required by `docs/self-support-float-funding-change.md`.
- **Float reduces as spent** — the cached `float_balance` fell by exactly the deployed
  principal each time and never went negative; returns/ROI still pay to withdrawable
  (unchanged).
- **Emails** — portfolio approval already emails the partner
  (`partner-self-managed-deployment` / `partnership-agreement`, idempotency-keyed);
  the top-up gap is now closed by `notify-self-topup-approved`.

## 4. Errors found during the run and how they were handled

| Error observed | Cause | Outcome |
|---|---|---|
| `function public.partner_support_houses(uuid[], integer, unknown) is not unique` | Two overloads (3-arg and 4-arg) exist; an untyped third argument is ambiguous | Test-harness issue, not a product bug — callers use named arguments. Left both overloads in place; noted so future callers pass `p_commitment_id` explicitly. |
| `PSM_TOPUP_WINDOW_CLOSED: This portfolio is pending_ops_approval` | Top-up attempted before Partner Ops approved the parent commitment | Correct, intended behaviour. Retested after approval → passed. |
| `Some selections are no longer held by you` | `partner_self_top_up` requires a live `partner_self_plan_claims` hold | Correct, intended behaviour (prevents two partners funding the same plan). Retested with a held claim → passed. |
| Top-up platform leg had no `float_usage` tag | Oversight in the Phase 1 patch | **Fixed** (migration in §2.4). |
| Top-up approval sent no partner email | Never implemented | **Fixed** (`notify-self-topup-approved`, §2.6). |

## 5. Performance / integrity notes

- All gates read one strict helper (`funder_float_capacity` → `funder_float_available` →
  `user_wallet_strict`), so a funding attempt performs a single balance round trip.
- The pending-portfolio hold is subtracted inside the helper, so the create gate no longer
  double-counted reservations.
- No wallet field is written directly anywhere in this change; the ledger triggers remain
  the sole writer, and `enforce_no_negative_wallet_ledger` stays the final backstop.
