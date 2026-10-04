---
name: Outstanding Balance — Instant Active, No Recalculation
description: Outstanding-balance rent_requests skip the formula trigger and the approval pipeline; auto-set status='repaying' and create the daily subscription_charge on insert
type: feature
---

**Decision (2026-05-13).**

When `rent_requests.registration_type = 'outstanding_balance'`:

1. **No fee recalculation.** `enforce_rent_request_formula` early-returns and forces `access_fee = request_fee = 0`. `total_repayment` and `daily_repayment` are stored verbatim from what the agent typed (`total_repayment = outstanding_balance`, `daily_repayment = ceil(outstanding_balance / duration_days)`).
2. **No approval needed.** BEFORE INSERT trigger `trg_auto_activate_outstanding_rent_request` sets `status='repaying'`, `tenancy_status='active'`, and stamps `approved_at / funded_at / disbursed_at / agent_ops_reviewed_at / tenant_ops_reviewed_at / landlord_ops_reviewed_at / coo_reviewed_at / cfo_reviewed_at` to `now()`.
3. **Auto subscription.** AFTER INSERT trigger `trg_create_outstanding_subscription_charge` inserts the `subscription_charges` row directly (frequency='daily', `next_charge_date = today + outstanding_grace_days`, `end_date = today + duration_days + grace_days`).

**Visibility.** Tenant immediately appears in:
- Agent dashboard → `AgentTenantsSheet` **Owing** tab (query already includes `'repaying'`).
- Tenant Operations → **Repaying** tab (filter `status === 'repaying'`).

**Why.** The rent formula (`rent × 1.33^n + reg fee`) does not apply to arrears already owed to the landlord. Tenants were seeing inflated daily charges because the trigger was overwriting the typed arrears with the formula amount.

Migration: `20260513082750` (functions `enforce_rent_request_formula`, `auto_activate_outstanding_rent_request`, `create_outstanding_subscription_charge`).