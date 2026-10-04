# Tenant self-payment did not fire — Nabutanda Fazira (+256754633975)

Date: 2026-09-17

## What we expect to happen

1. Tenant deposits money.
2. System checks whether the depositor has an active Rent Plan (`repaying` / `funded` / `disbursed`, still owing).
3. The deposit is used to pay today's instalment from the tenant's own wallet money.
4. Agent earns the 10% commission (collector 8% + verified parent 2% where a parent exists).
5. The collection is recorded with `performance_weight = 2` (double performance credit).
6. Tenant and agent both receive an SMS.

Agents who collect for clients are deliberately excluded — their deposits are client float.

## What actually happened

- Deposit `1b73e6da…`, UGX 20,000, approved 2026-09-17 14:14, purpose `operational_float`.
- The approval trigger did run and the engine did evaluate her: attempt row recorded
  `outcome = refused`, `reason = no_withdrawable_balance`, with `outstanding = 352,500`,
  `daily_repayment = 11,750`, `due_now = 11,750`, `withdrawable = 0`.

Root cause: **deposit routing vs. the money the engine was allowed to spend.**

`approve-deposit` routes every deposit to the **float** bucket by default
(float-by-default, 2026-07-28; only receipt-code "personal deposit" goes to withdrawable).
Her UGX 20,000 therefore landed in `float_balance`, and `settle_tenant_rent_from_deposit`
only ever spent `withdrawable_balance`. So the tenant's own money was sitting in her wallet
while the engine reported "no withdrawable balance" and refused.

It "used to work" for tenants whose deposits happened to land in withdrawable; anyone whose
deposit was tagged operational float silently stopped self-paying.

## Fix applied

Migration `0170_tenant_self_payment_use_own_deposited_float.sql` patches
`public.settle_tenant_rent_from_deposit` (function patched in place from its live definition,
so nothing else in it drifted):

- Availability is now `withdrawable + float`, **but the float side counts only when the
  depositor is not an agent actor** (no plans they collect on, no collections, no float
  limit). Agents are unchanged — their float stays untouched company/client money.
- The wallet debit is now posted per bucket: `tenant_rent_settlement` (withdrawable portion)
  and `agent_float_used_for_rent` (own-deposit portion). Both legs remain balanced against
  the platform `tenant_repayment` leg, and all writes still go through
  `create_ledger_transaction`.
- Refusal label `no_withdrawable_balance` → `no_available_balance`, and the attempt row now
  records `applied_from_withdrawable` / `applied_from_float` / `money_source`.

Unchanged on purpose: strictly-daily application (one instalment, no arrears catch-up),
commission split, `performance_weight = 2`, both SMS notices, trust signal, treasury
waterfall.

## Fazira settled

Ran the engine on her deposit:

- Applied UGX 11,750 (today's instalment); UGX 8,250 surplus left in her wallet.
- Plan `10906d51…` moved `funded` → `repaying`; outstanding UGX 340,750.
- Waterfall posted: access 2,750, registration 667, principal 8,333, partner reward 1,250,
  agent commission 1,175 (collector 940 + parent 235).
- Collection recorded with `performance_weight = 2`.
- SMS: tenant `+256754633975` **sent**, agent `+256789190055` **sent**.

## Recommendations

1. Route a plain tenant's deposit to withdrawable at approval time (correct semantics), so
   float is only ever used for agents. The fix above makes the engine bucket-agnostic, but
   the routing itself is still misleading in reports.
2. Alert on `tenant_self_repayment_attempts` refusals per day by reason — this failure was
   fully recorded for weeks and nobody was told.
3. `payer_number_mismatch` and `agent_float_deposit_not_rent_purpose` refusals are the next
   two biggest buckets; both deserve a review pass.
