# Merchant Agent Float Deficit Gate — Analysis (no code changed)

_Analysis only. Date: 2026-08-14. Updated 2026-08-14 to remove the 24-hour gate. Nothing in the codebase or database was modified._

---

## 1. What is being asked

Clarify the merchant agent float model:

1. A merchant agent **does have a float bucket** in their wallet, just like operational float.
2. Payouts consume the merchant's **own float bucket first**.
3. When their float hits 0, show: *"Operational float is finished, you can continue processing pay-outs"* — they keep paying, and each payout beyond 0 becomes a **receivable against the company** (the merchant is now demanding money).
4. **No 24-hour block.** Because merchants settle with Financial Operations every morning, a hard day-boundary gate is redundant.
5. A merchant **can still request float** at any time, but the request is not a prerequisite for paying out — they can keep operating in deficit mode and settle the next morning.
6. Case: Pius funded UGX 20,000,000 → spends it all → float 0 → keeps paying out and accrues a demand → settles with FinOps the next morning.

---

## 2. Do merchant agents have "merchant float" like operational float?

**Yes.** Merchant agents hold a real `float_balance` bucket in the `wallets` table, distinct from `withdrawable_balance` and `advance_balance`. It works the same way as operational float for other agent types:

| Field | What it represents |
|---|---|
| `wallets.float_balance` | Company money loaded by Finance, held in the merchant's wallet, used only to settle customer cash-outs. |
| Credits | `agent_float_deposit` legs (wallet scope, cash_in, float bucket). |
| Debits | `agent_float_settlement` legs (wallet scope, cash_out, float bucket) — principal + telecom charge. |

The only difference from generic operational float is the **category** it moves through (`agent_float_settlement`) and the fact that it is reconciled daily against the merchant's actual MTN/Airtel statement. But mechanically it is the same bucket concept.

---

## 3. How it works today (baseline)

### 3.1 Money mechanics per settled payout (`approve-withdrawal`)
For payout amount **A** with telecom charge **T** (tiers 100/500/1,000/1,500/2,000 UGX from `src/lib/cashoutCharges.ts`):

| Leg | Scope | Direction | Bucket | Category |
|---|---|---|---|---|
| Customer balance discharged | wallet | cash_out | withdrawable | `wallet_withdrawal` |
| Company float consumed (principal) | wallet | cash_out | **float** | `agent_float_settlement` |
| Float settled to platform | platform | cash_in | — | `agent_float_settlement` |
| Telecom charge | wallet | cash_out | **float** | `agent_float_settlement` (ref `<id>-merchant-telecom-charge`) |
| Commission expense | platform | cash_out | — | `agent_commission_earned` |
| Commission to merchant (0.5% × A) | wallet | cash_in | withdrawable | `agent_commission_earned` |

Invariant already in force: **Float allocated = customer payouts + telecom charges + remaining float.**

### 3.2 Float reservation and the shortfall path
- `reserve_merchant_float` locks the claimable slice: `reserved = min(float_balance − open reservations, A + T)`.
- If float covers less than `A + T`, the engine **does not block**. It debits float for what exists and files the remainder into `merchant_out_of_pocket_advances` with status **`needs_review`**. It only becomes money owed after `review_merchant_out_of_pocket` (merchant/FinOps confirmation) — the evidence gate.
- `INSUFFICIENT_MERCHANT_FLOAT` as a hard stop is effectively bypassed by the shared-pool model; the pool figure (`get_merchant_payout_float().available_float`) is a **network** number (all withdrawable + landlord float − claimed-unsettled), not the merchant's spendable money.

### 3.3 Requisition side
- There is **no merchant-side request button today**. `float_requests` rows are raised for them by FinOps (`MerchantFloatRequisitionPanel`), reported in the CFO `MerchantFloatRequisitionReportPanel`.
- The per-agent "fair-share forecast" was deliberately deleted (see `mem://features/agent/merchant-float-demand-forecast`) — the CFO is the gatekeeper, and self-service allocation was explicitly rejected.

### 3.4 The Finance truth board
`get_merchant_float_positions()` computes, per desk, since the anchor date:
- `paid_out_total` (completed payouts attributed to the desk)
- `float_credits_recorded` (real `agent_float_deposit` cash-in float legs) — the authoritative reimbursement figure
- `email_matched_total` — **evidence only**, never summed into reimbursement (adding it once produced a false "we owe agents UGX 384m")
- `adjustments_total` from `merchant_float_reconciliations`
- `owed_to_agent` / `company_cash_with_agent` = the two non-negative sides of `paid_out_total − reimbursed_total`.

---

## 4. What the revised model changes

| Dimension | Today | Revised (no 24h gate) |
|---|---|---|
| Float source order | reservation-based, shortfall silently fronted | explicit **float-first**, then tracked deficit mode |
| Zero float | keeps paying indefinitely, unbounded fronting | keeps paying indefinitely, but now **explicitly messaging** that float is finished and the merchant is fronting the company |
| Day boundary | no meaning | **no meaning** — no block |
| Unblock | none needed | next-morning settlement with FinOps, or any real float credit |
| Merchant requisition | FinOps-only | **add merchant-initiated request** (optional, always available) |
| Receivable creation | `needs_review`, confirmation required | unchanged |

The important conceptual shift: the out-of-pocket receivable is no longer a
driver of eligibility; it is purely a **transparency and settlement artifact**.

---

## 5. Financial-flow impact

### 5.1 Ledger
No new ledger categories or legs are required. Float debits, telecom debits and
commission credits stay identical. `apply_wallet_movement` remains the sole
wallet writer; nothing here justifies a new mutation path.

### 5.2 Balance-sheet effect of deficit mode
Every payout made at float ≤ 0 creates a liability *Due to merchant agents*
(credit) against *Cash disbursed on behalf of customers* (debit). Because the
customer's wallet is discharged at the same moment, the company's payable simply
moves from **customer withdrawable** to **merchant receivable**. Net obligation
is unchanged; only the counterparty changes.

Because the merchant settles with FinOps every morning, this receivable is
short-lived and well-bounded. The key requirement is that it remains **visible**
so the morning settlement has something to reconcile against.

### 5.3 Numbers that must be shown
Recommended display formula:

```
spendable_float = min(wallets.float_balance,             -- cache
                      ledger_float_held)                  -- proven legs
                 - open_reservations
fronted_today   = max(0, confirmed_out_of_pocket_owed - float_credits_since)
```

Notes that matter for correctness:
- **Use the strict/min rule.** `ledger_float_held` must cap the cached
  `float_balance`, exactly as the Money-With-Agents card already does. Otherwise
  cache drift lets a merchant "prove" float they never received.
- **Off-ledger adjustments are not spendable float.** `merchant_float_reconciliations`
  can settle a deficit for reporting purposes but must not be mistaken for cash
  the payout engine can consume.
- **Email-matched MoMo credits stay evidence-only.** Using them to clear a
  deficit re-introduces the double-count that produced the phantom UGX 384m.
- **Telecom charge belongs in the float consumption**, not just the principal: the
  float requirement per payout is `A + T`.

### 5.4 Commission and incentives
Commission (0.5%) lands in withdrawable and is unaffected. The merchant keeps
earning commission while fronting the company, which is acceptable because the
fronting is now visible and settled daily.

---

## 6. Risks and edge cases (revised, no gate)

| Risk | Why it bites | Mitigation |
|---|---|---|
| Unbounded fronting grows silently | Without a gate, a merchant could front large sums if settlement is missed | Morning settlement is mandatory; FinOps board shows `fronted_today` per desk |
| Cache drift hides true float | Inflated `float_balance` reads as spendable | strict `min(cache, ledger)` rule |
| Deficit created by telecom charges only | Merchant feels punished for fees | Reserve `A + T`; surface charges separately in the merchant statement |
| Duplicate/again-claim races | Two claims against the same last shilling of float | Existing reservation lock |
| Reconciliation used as a shortcut | Deficits cleared on paper without cash | Require ≥10-char reason (already enforced) and keep adjustments out of spendable float |

---

## 7. Surfaces that need to agree (revised)

- **Merchant claim path** (`approve-withdrawal` claim stage) — no gate added; keep current reservation logic.
- **Merchant dashboard** (`AgentCashPayoutsTab`, `MerchantFloatAvailableCard`, `MerchantDashboardHome`) — show:
  - own float balance,
  - "Operational float is finished" message when float ≤ 0,
  - amount fronted today / owed by company,
  - a **Request float** button that inserts into the existing FinOps/CFO queue.
- **Merchant payout queue helper** (`src/lib/merchantPayoutQueue.ts`) — unchanged; no fence needed.
- **FinOps** — `MoneyWithAgentsCard` + `MerchantFloatRequisitionPanel`: show who fronted money and settle them; settlement must be a real float credit, not a UI flag.
- **CFO** — float requisition and merchant float statement reports gain a "fronted today / unsettled" line.
- **Daily merchant cash-out report** — should include float consumed, telecom charges, and amount fronted.

---

## 8. Answering the open questions in the brief

> "Do we have merchant float, just like operational float?"

**Yes.** Merchant agents have a dedicated `float_balance` wallet bucket. It is
loaded via `agent_float_deposit` ledger legs and consumed via
`agent_float_settlement` legs. The only operational difference is that it is
reconciled daily against the merchant's MTN/Airtel statement.

> "A merchant agent will have a button to request float, but I think this is not
> needed since he can still operate despite having no float."

The button **should still exist** but as a convenience, not a gate. Because the
merchant can keep paying after float hits 0, the request button is not
required before each payout. It becomes a way to ask Finance for a top-up
whenever they want more float, without interrupting operations.

The safe shape is the one already proven by `MerchantFloatRequestCard`: free-text
amount + reason, one open request at a time (`hasPending` disables both the
button and the mutation), landing in the existing FinOps/CFO queue. No
self-allocation, no fair-share forecast — that model was explicitly rejected
and must not return.

> "Once a day ends, the agent can't process a payout until they settle the deficit."

**Discarded.** Because merchants settle with FinOps every morning, the 24-hour
block is redundant and would create unnecessary operational friction. The
merchant can continue processing payouts at any time; the deficit is simply
tracked and settled at the next morning reconciliation.

---

## 9. Verdict

The revised proposal is simpler and safer than the gated version. It keeps all
existing money mechanics intact, adds transparency for both the merchant and
Finance, and avoids the complexity and edge cases of a 24-hour eligibility gate.
The only implementation work is UI/UX: clearer float-first messaging on the
merchant dashboard, a non-blocking "Request float" button, and a morning
settlement view in FinOps.
