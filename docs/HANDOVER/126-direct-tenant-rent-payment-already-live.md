# 126 — Direct tenant rent payments: already live; retire the unsafe duplicate

**Status (2026-09-24):** code + migration committed, **not yet pushed/deployed**.

## Request

"Link a tenant's number and profile to an appropriate agent so that if they make a direct deposit,
the agent gets the commission and is notified that their tenant has paid rent."

## Finding: this already works in production

When a tenant pays Welile's MTN/Airtel till from the phone on their profile:

1. `gmail-poll-transactions` ingests the SMS email, matches the sender phone to the profile, and
   auto-credits a `deposit_requests` row via `approve-deposit`.
2. On approval, `trg_tenant_self_repayment_on_approval` calls **`settle_tenant_rent_from_deposit`**,
   which:
   - picks the Rent Plan and its agent via `tenant_self_repayment_plan(tenant)` (the plan's agent
     *is* the tenant↔agent link, so nothing extra needs storing),
   - refuses agents' own float top-ups (`agent_float_deposit_not_rent_purpose`), since an agent is
     identified by acting as one (plans as agent / collections / float limits), not by having the
     `agent` role, which tenants often carry too,
   - checks identity against `user_deposit_numbers` (`payer_number_mismatch` if the tenant has
     registered numbers and the profile phone isn't one),
   - applies the payment, writes the agent's receipt-book row (`agent_collections`,
     `collection_channel = 'tenant_deposit_auto'`), posts commission (10%, or 8% + 2% recruiter
     override; waterfall-scope plans use the waterfall's commission),
   - queues an SMS to the tenant and one to the agent in `tenant_self_repayment_notices`.
     All 70 sent to date have `sms_status = 'sent'` (35 tenant, 35 agent). The agent also gets
     the in-app "Commission Paid" notification from `notify_agent_commission_paid`.

`tenant_self_repayment_attempts` since 2026-09-04: 35 settled; 967 refused as agent float
top-ups; 231 no active plan; 83 `payer_number_mismatch` (only 5 of those, UGX 751,000, involve a
Rent Plan).

## What was wrong

1. **A second, unsafe implementation sat half-wired.** `gmail-poll-transactions` called
   `record_direct_tenant_rent_payment` before the normal auto-credit. Its migration
   (`20260907130000`) was **never applied**, so all 116 calls since 2026-09-07 failed with
   "function not found" and fell through harmlessly. But **every one of those payers with an open
   rent request was an agent topping up float** (Peter Bukoma, Mata Pius, Kirunda Ivan, Shakirah
   Nakimbugwe, …). That function had no agent check, so if the migration had ever auto-applied
   (repo migrations sometimes do) it would have redirected their float top-ups into rent
   repayments, sometimes paying an agent commission on their own rent. It also treated `pending`
   and `deleted_by_agent` plans as owed.
2. **The agent SMS always said "his".** "*Martha Namigadde paid his own rent … His rent balance …
   No collection needed from him*".

## Changes

- `gmail-poll-transactions`: removed the `record_direct_tenant_rent_payment` call block; comment
  points to the live path.
- `20260907130000_direct_tenant_rent_payment.sql`: replaced with a documented no-op so it can
  never be applied late.
- `20260924180000_tenant_self_repayment_agent_sms_neutral_wording.sql`: patches the **live**
  `settle_tenant_rent_from_deposit` body in place (`pg_get_functiondef` → `replace` → `execute`),
  changing only three SMS phrases (“paid their rent directly”, “Rent balance”, “No collection
  needed until”). Refuses to run if the phrases aren't found. A read-only dry run against
  production matched 2/2/1 occurrences, left no gendered words, and changed the body by 3
  characters. The function is not in `critical_function_baselines`, so no re-baseline is needed.

## Verify after deploy

```sql
-- migration applied?
select position('paid their rent directly' in pg_get_functiondef('public.settle_tenant_rent_from_deposit(uuid)'::regprocedure)) > 0;
-- dead RPC errors stopped (after the edge function redeploys)
select max(created_at) from deposit_decision_audit where reason = 'direct_tenant_rent_payment_rpc_error';
```

## Martha Namigadde (TID157162005754)

Once handover 125's rescan ingests her email, the path above settles it: plan `660d8178…`, agent
Mwaka Isaac, UGX 212,112 outstanding, no registered numbers (`unverified_no_registered_number`
is allowed), no agent activity of her own. Confirm with
`select * from tenant_self_repayment_attempts where tenant_id = '41383cef-a13c-456e-861d-01aa797f192c';`

## Tenants paying from another number

The email reader resolves the sender with `resolve_user_by_known_phone` (profile `phone`,
`mobile_money_number`, and `user_deposit_numbers`), and auto-credits only when exactly one user
owns the number. So a tenant paying from a second phone is matched once that number is linked
to them. `learnDepositNumber` links it automatically the first time Financial Ops manually
routes such a payment to the tenant. If the number is shared with another user, nothing is
auto-credited, by design.
