# Merchant (Cash-Out) Agent Payout Process

_Last updated: 2026-07-07_

This document describes exactly how a merchant (cash-out) agent settles a
customer payout, where the money moves, and every check that can block a
payout. It exists because agents frequently hit errors mid-payout and support
needs a single source of truth to diagnose them.

---

## 1. Who is involved

| Actor | Role in a payout |
|-------|------------------|
| **Customer** | The person cashing out. Requests the payout and receives the cash / mobile money. |
| **Merchant (cash-out) agent** | Physically dispenses the money **from company float they are holding**, then confirms the payout in the app. Earns 0.5% commission per settled payout. |
| **CFO / Treasury** | Pre-loads **float** (company money) into the merchant's float bucket. Without float, the agent cannot settle anything. |
| **FinOps** | Verifies / approves certain payout types and reconciles settlements. |

---

## 2. The two wallet buckets a merchant agent holds

A merchant agent's wallet has two **completely separate** buckets. Confusing
them is the #1 source of agent frustration.

| Bucket | What it is | Can the agent withdraw it? |
|--------|-----------|-----------------------------|
| **Float** | Company money loaded by CFO/Treasury. Used **only** to settle customer cash-outs. | No. It is not the agent's money. |
| **Withdrawable** | The agent's own earnings — 0.5% commission on every payout, plus payroll etc. | Yes, via the normal Withdraw flow. |

> **Key rule:** Settling a customer payout **drains the agent's float** and
> **credits a small commission to their withdrawable**. Money never lands in
> the agent's withdrawable from the payout principal itself.

---

## 3. End-to-end flow

1. **Customer initiates a cash-out** (`WithdrawFlow` / `WithdrawRequestDialog`).
   They may pick a nearby cash agent (`CashAgentSelector`). A row is created in
   `withdrawal_requests` with status `pending` / `requested`.
2. **Merchant agent claims the request.** The app calls the `approve-withdrawal`
   edge function, which **atomically flips the status to `processing`** so two
   agents (or two clicks) can never pay the same request twice.
3. **`approve-withdrawal` runs its safety gates** (see section 4) and, if all pass:
   - Posts the balanced ledger entries that discharge the customer's balance.
   - **Consumes the agent's float** by the payout amount (`agent_float_settlement`).
   - **Credits 0.5% commission** to the agent's withdrawable (`agent_commission_earned`).
   - Sends SMS + push notifications to both the agent and the customer.
   - Marks the request `completed` / `paid`.
4. **Agent later withdraws their accumulated commission** from the withdrawable
   bucket — a separate, ordinary withdrawal.

---

## 4. Every gate that can block a payout (in order)

`approve-withdrawal` runs these checks. Understanding them explains almost every
error an agent sees.

| # | Gate | Blocks when… | Agent-facing meaning |
|---|------|--------------|----------------------|
| 1 | **Fraud block** | The requester is flagged in `fraud_identity_blocks`. | Payout refused; escalate to CFO. |
| 2 | **Pickup-code gate** (cash payouts) | Wrong WPO pickup code entered. | Ask the customer for the correct code. |
| 3 | **Chosen-merchant gate** | A different agent than the one the customer chose tries to settle. | Only the assigned agent can pay this one. |
| 4 | **Brute-force gate** | Too many wrong codes / retries. | Temporarily locked; wait and retry. |
| 5 | **Duplicate reference** | The same MoMo TID / bank reference was already used on a completed payout. | Use the real, unique transaction reference. |
| 6 | **Atomic claim** | The request is already `processing`/`completed` (someone else took it). | Refresh — it is already being handled. |
| 7 | **Merchant float pre-check** | `float_balance < payout amount`. | **`INSUFFICIENT_MERCHANT_FLOAT`** — ask CFO/Treasury to top up float first. |
| 8 | **Pivot / balance guard** | The customer's cached wallet disagrees with the ledger. | **`BALANCE_MISMATCH`** — a reconciliation issue on the *customer's* wallet, not the agent's float. (Guard was made consistent on 2026-07-07 so legitimate payouts are no longer falsely blocked.) |
| 9 | **Ledger post** | The balanced double-entry fails. | Transient; retry, then escalate. |

> Only after **all** gates pass does the float get consumed and commission paid.
> A failed gate releases the claim (status returns to `pending`) so the request
> can be retried.

---

## 5. Money movement (ledger legs)

For a payout of amount **A** settled by a merchant agent:

| Leg | Scope | Direction | Bucket | Category |
|-----|-------|-----------|--------|----------|
| Customer balance discharged | wallet | cash_out | withdrawable | `wallet_withdrawal` |
| Company float consumed | wallet | cash_out | **float** | `agent_float_settlement` |
| Float settled to platform | platform | cash_in | — | `agent_float_settlement` |
| Commission expense | platform | cash_out | — | `agent_commission_earned` |
| Commission to agent | wallet | cash_in | **withdrawable** | `agent_commission_earned` |

Net effect: **company float (held by the agent) → customer**, and the agent
keeps **0.5% × A** as spendable commission.

---

## 6. Charges & commission

- **Commission:** `0.5%` of every settled payout (`CASHOUT_COMMISSION_RATE`),
  credited instantly to the agent's withdrawable bucket.
- **Telecom sending charge tiers** (`src/lib/cashoutCharges.ts`):

  | Amount sent (UGX) | Telecom charge |
  |-------------------|----------------|
  | 0 – 5,000 | 100 |
  | 5,001 – 60,000 | 500 |
  | 60,001 – 500,000 | 1,000 |
  | 500,001 – 1,000,000 | 1,500 |
  | 1,000,001 – 5,000,000 | 2,000 |

---

## 7. Common problems agents report & what they really mean

| Symptom | Real cause | Fix |
|---------|-----------|-----|
| "Insufficient merchant float" **despite having float** | Float is below the payout amount, or the amount includes fees the agent didn't account for. | CFO/Treasury tops up the agent's **float** bucket. |
| "Balance mismatch" (blank screen / 409) | The **customer's** wallet cache diverged from the ledger (e.g. after a CFO balance retraction). Not an agent problem. | Guard now honors CFO retractions & in-flight holds (fixed 2026-07-07). If it recurs, CFO reconciles the customer wallet. |
| "Duplicate reference" | The same mobile-money TID / bank ref was reused. | Enter the actual unique reference from the telecom/bank. |
| Payout button does nothing / "already processing" | Another agent claimed it, or a previous attempt is still locked as `processing`. | Refresh the queue; the claim auto-releases on failure. |
| Commission not visible | Commission lands in **withdrawable**, shown on the Withdrawable Wallet card — separate from float. | Check the Withdrawable Wallet card, not Available Float. |

---

## 8. Key files

- Edge function: `supabase/functions/approve-withdrawal/index.ts` (all gates + money movement)
- Agent cards: `src/components/agent/MerchantWithdrawableCard.tsx`, `MerchantFloatRequestCard.tsx`
- Customer flow: `src/components/payments/WithdrawFlow.tsx`, `src/components/wallet/CashAgentSelector.tsx`
- Economics: `src/lib/cashoutCharges.ts`, `src/lib/cashoutAgentConfig.ts`
- CFO oversight: `src/components/cfo/CashoutAgentManager.tsx`, `AgentFloatManagement.tsx`
- FinOps: `src/components/financial-ops/FinOpsWithdrawalVerification.tsx`, `MerchantClaimsLog.tsx`
