# Self Support (Partner Self Portfolio Management) — E2E Smoke Test Report
Date: 2026-08-05 · Environment: production database, fully sandboxed dummy data (transaction rolled back)

## How it was run
A temporary security-definer harness (`psm_e2e_smoke`) created a throwaway partner, an ops
(partner_ops) viewer, a verified landlord, 5 dummy tenants with rent plans (UGX 200,000 each) and a
ledger-backed wallet of UGX 600,000, then drove the real production RPCs end to end. The wrapper
(`psm_e2e_run`) deliberately raised at the end so **every** dummy row — auth users, profiles,
rent plans, ledger legs, commitments — was rolled back. No live user, wallet, ledger or portfolio
was touched. The harness and its temporary runner were removed after the run.

Result: **22 of 23 assertions pass. 1 real gap remains (case 7b, see below).**

## Case scenario 1 — first-time support

| # | Assertion | Result | Evidence |
|---|---|---|---|
| 1a | Selecting tenants beyond withdrawable balance is blocked | PASS | "Selected plans total UGX 1,000,000. Your wallet has UGX 600,000 available. You are UGX 400,000 over." |
| 1b | Selecting inside the balance holds the plans (10-min claim) | PASS | 2 plans claimed, no plans lost to other partners |
| 1c | Confirmation summary + confirm creates the portfolio | PASS | committed UGX 400,000, monthly return UGX 60,000 |
| 1d | Capital locked in funding lines at 15% | PASS | 2 live lines, principal UGX 400,000, rate 15 |
| 1e | 12-month term with a monthly payout clock | PASS | term_end +12 months, next payout +1 month |
| 1f | Capital deployed to the company landlord-float pool | PASS | wallet cash_out 400,000 = platform `partner_funding` cash_in 400,000 |
| 1g | Principal is NOT visible/withdrawable in the wallet | PASS | available drops 600,000 → 200,000 |
| 1h | Tenant plans stamped with the partner (self support label) | PASS | 2 plans carry `self_funding_partner_id` + line id |
| 2a | Returns accrue at 15% per cycle | PASS | UGX 58,064 recognised for a 30/31-day cycle |
| 3a | Nearing-payout queue visible to Partner Ops / COO | PASS *(after fix)* | 1 row, expected total UGX 60,000 |
| 3b | Ops can open an individual self-support portfolio | PASS *(after fix)* | committed 400,000, earning 400,000, earned 58,064 |
| 4a | Cycle payout credits the partner's withdrawable wallet | PASS | +UGX 58,064 → 258,064 |
| 4b | Only returns land in the wallet, never the principal | PASS | delta 58,064, principal stays deployed |

## Case scenario 2 — top-ups and re-support

| # | Assertion | Result | Evidence |
|---|---|---|---|
| 5a | Top-up allowed mid-term | PASS | 334 days remaining, 30 days left in cycle |
| 5b | Top-up capital deploys immediately | PASS | wallet 258,064 → 58,064 for a UGX 200,000 top-up |
| 5c | Top-up earns pro-rata for the part-month, full rate afterwards | PASS | pro-rata UGX 29,032 vs full UGX 30,000 (30/31 days) |
| 5d | Topped-up line inherits the parent maturity (no term reset) | PASS | line term_end = portfolio term_end |
| 5e | Committed principal after top-up | PASS (with note) | rises to UGX 600,000 immediately |
| 5f | After the cycle ends the top-up is part of the earning base | PASS | next cycle UGX 89,032 on the 600,000 base (top-up line UGX 29,032) |
| 6 | Top-up blocked in the final 90 days before maturity | PASS | "matures in 45 days … new capital starts a fresh 12-month portfolio" |
| 7a | A completed tenant plan closes the funding line | PASS | line status → completed |
| 7b | Re-support a new tenant with the SAME already-deployed capital | **FAIL** | no redeploy path exists (see below) |

## What was failing and what changed

1. **Partner Ops could not see self-support portfolios (fixed).**
   `partner_self_nearing_payouts` and `partner_self_portfolio` only authorised
   COO / CEO / CFO / manager / super_admin / `is_ops_role`. A pure `partner_ops` (or
   `financial_ops`) user hit `Not authorised`, so the panel on their own dashboard was empty/erroring.
   Both RPCs now also accept `partner_ops` and `financial_ops`. COO visibility was already correct.

2. **Re-support with already-deployed capital is not implemented (open gap).**
   When a funded plan completes, the funding line is closed (7a passes) but:
   - the principal is *not* returned to the partner's withdrawable wallet (correct — it is still
     working inside the company pool), and
   - there is **no RPC to point that freed principal at a new tenant**.
   Net effect today: after a tenant finishes, the partner's capital sits as a `completed` line and can
   only be re-deployed by depositing fresh money. Requested behaviour ("partner must use the
   prev/already deployed capital to re-support a tenant") needs a new
   `partner_self_redeploy(commitment_id, rent_request_ids[])` that consumes completed-line principal
   instead of wallet balance. Not built in this pass — it is a new feature, not a bug fix.

3. **Note on top-up principal semantics.** `committed_amount` increases the moment the top-up is
   deployed rather than at the cycle boundary. Economically the requested rule is honoured through
   pro-rata earnings (the top-up only earns for the days it was live), so returns are never
   overpaid. If you want the *displayed* principal to change only at the cycle boundary, that is a UI
   presentation change on the portfolio card.

## Notes for real-world testing
- Accrual for a 31-day cycle on UGX 400,000 is UGX 58,064, not exactly 60,000 — the engine pays by
  days live, which is expected.
- Claims expire after 10 minutes; a partner who idles on the confirm screen releases the plans.
- Maturity guard blocks top-ups within 90 days of term end and directs new capital to a fresh
  12-month portfolio.
