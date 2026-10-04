# 152 — CFO: settle a tenant shortfall from the agent's advance top-up, in one step

**Status: migration written and dry-run on production (rolled back); NOT YET APPLIED, and nothing has been settled.** Instructed by Joshua Wanda (CFO role) on 2026-09-29.

**Migration:** `20260929130000_cfo_settle_tenant_shortfall_via_advance_topup.sql`
**RPC:** `cfo_settle_tenant_shortfall_via_advance_topup(p_advance_id, p_rent_request_id, p_amount, p_extend_days, p_reason)`

## Why

Magawa Joan (0742508052, `511cde17-b810-4908-86eb-2bcb586a6454`) has an active Rent Plan (`68b2e167-c8a8-4b70-801c-ce21a73c1132`): 419,000 due, 319,000 repaid, **UGX 100,000 outstanding**. (The collections table sums to 419,000 only because 10 rows / 100,000 were reversed on 16 Sep as duplicate submissions; net live collections are 319,000, matching `amount_repaid`.)

She paid her agent by hand and the agent, **Maasa Mubakal** (+256746438923, `12a61401-7b72-4a71-b550-1d1b49647311`), did not pay all of it in. The CFO ruled he is liable for the 100,000, charged to his advance, so the plan is settled and Joan can be moved to another agent for new rent.

A top-up alone does not do that: it credits the agent's wallet and raises his advance, but leaves the tenant's plan open. Two separate steps would leave a window where the agent holds spendable money and the plan is open, with no single audit record. There was no existing settlement path (`agent_liability_*` columns on `rent_requests` are only read by a May-era report).

## What the RPC does (one transaction)

| # | Step | Effect |
|---|---|---|
| 1 | `apply_advance_topup(..., p_override_eligibility := true)`, **unmodified** | Wallet `agent_advance_credit` in, platform `agent_advance_disbursement` (DR A10 / CR L1), access fee A11/R2, advance principal/outstanding/cycle raised, `agent_advance_topups` row |
| 2 | Group A | DR L1 `tenant_rent_settlement` (agent wallet, `cash_out`, withdrawable) / CR A3 `tenant_repayment` — same shape as Route B (`20260908181000`), money source is the **agent's** wallet |
| 3 | `agent_collections` row | channel `agent_liability_settlement`, `performance_weight` 0, float unchanged |
| 4 | `record_rent_request_repayment_v2` | The authoritative repayment path: `amount_repaid`, `repayments` row, plan → `completed` when cleared. Plan is legacy scope, so no waterfall (`legacy_path_no_waterfall`) |
| 5 | `audit_logs` (`agent_shortfall_settled_via_advance`) + `system_events` | |

**Not done on purpose:** no commission to the agent or a recruiter (it is his own shortfall); no float or `agent_tid_backed_float` movement (the TID-backed rule for float-funded collections is not weakened; this money is an advance recorded as an A10 receivable, not float); no change to `apply_advance_topup`, `create_ledger_transaction`, the mapping or the allowlist (`tenant_rent_settlement` and `tenant_repayment` were already mapped and allowlisted).

**Guards:** signed-in CFO / manager / super_admin only (service role refused); reason ≥ 10 chars; the advance must belong to the plan's agent; plan must be open; amount ≤ outstanding; one settlement per plan; ledger idempotency key from plan + top-up id.

## Dry run (2026-09-29, production, rolled back)

Run as Joshua (`cb798acb…`) inside a `DO` block that ends in `RAISE EXCEPTION`, so nothing persisted. Inputs: advance `12f0f159…`, plan `68b2e167…`, 100,000, 30 days.

| | Before | After (in the rolled-back txn) |
|---|---|---|
| Plan `amount_repaid` / status | 319,000 / `repaying` | **419,000 / `completed`** |
| Agent wallet withdrawable | 3,200 | 3,200 (100,000 in, 100,000 out) |
| Agent float | 0 | 0 |
| Advance principal | 350,000 | 450,000 |
| Advance outstanding | 235,129 | **368,129** (+100,000 principal +33,000 access fee) |
| Advance status | `overdue` | `active` (existing top-up behaviour) |

The first attempt failed on `agent_collections.float_before NOT NULL`; fixed by recording the current float in both columns.

## Consequences for the agent to be aware of

- His advance was already `overdue` (235,129 outstanding, 112,658 arrears, expired 25 Sep). The top-up (existing behaviour) sets it back to `active`, extends the cycle by 30 days and re-spreads the instalment (~14,159/day). Arrears are not cleared by this.
- **He is charged the 33,000 access fee** (33% monthly, 30 days) on top of the 100,000. If the CFO does not want the fee charged for a liability settlement, pass `p_extend_days` small (the fee scales with days) or say so and this needs a fee-waiver variant.

## Still to do

1. **Apply the migration** (push to the confirmed remote, then verify the function exists live — repo migrations sometimes never auto-apply).
2. **A CFO must call it** while signed in (it refuses service-role calls). There is no UI yet; that is Gemini's lane. Call shape:
   `select public.cfo_settle_tenant_shortfall_via_advance_topup('12f0f159-6a3f-46f0-9872-2953658bb757','68b2e167-c8a8-4b70-801c-ce21a73c1132',100000,30,'<CFO ruling text>');`
3. Move Joan to another agent afterwards (not part of this RPC).
4. Post-run checks: plan `completed`, agent wallet withdrawable unchanged, advance outstanding 368,129, `assert_money_path_intact()` still 17/17, no new `ledger_mapped_balance_violations` for the new group.

## Open questions for the CFO

- Access fee on the 100,000: charge it (as built) or waive it?
- The agent earned commission on the 319,000 that was recorded. Whether commission on the shortfalled part should be clawed back is a separate ruling; not touched here.
