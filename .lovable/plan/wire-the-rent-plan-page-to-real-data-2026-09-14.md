# Wire the Rent Plan page to real data

The Rent Plan screen (`/dashboard/rent-plan`) currently shows a hard-coded example plan
(UGX 450,000, Sarah Namuli, Kawafu) and the Pay Now button only shows an alert. This plan
replaces both with the tenant's real plan and a working payment.

## What the tenant will see

- Their own live plan: total, paid, balance, percentage paid, daily amount, days left,
  start/end dates, house, agent, behaviour score.
- Their real recent payments (amount, how it was paid, date).
- Pay Now that actually moves money from their wallet to their rent balance, with a
  receipt reference, and the page refreshing to the new balance.
- Plain empty state when there is no active plan, and a loading state while it fetches.

## Backend

One new read function, `tenant_rent_plan_detail()` — SECURITY DEFINER, no arguments, it
only ever reads the signed-in tenant's own data (`auth.uid()`), granted to
`authenticated`. It returns a single JSON object:

- Plan: `rent_requests` row for the tenant with status in
  `funded`/`disbursed`/`repaying` and tenancy not ended, oldest active first —
  `id`, `status`, `total_repayment`, `amount_repaid`, `daily_repayment`,
  `duration_days`, start (`disbursed_at` falling back to `created_at`),
  end (start + `duration_days`), `initial_outstanding_balance`.
- House: `house_listings.title` + `district`/`region` for the tenant's linked house,
  falling back to `rent_requests.house_category` + `request_city`.
- Agent: `profiles.full_name` for `assigned_agent_id` falling back to `agent_id`.
- Behaviour score: `welile_trust_score_cache.score` for the tenant (0 when absent).
- Amount due today: existing `rent_plan_amount_due_now(plan_id)`.
- Recent payments: last 10 rows of `repayments` for the plan (amount, `payment_method`,
  `created_at`), method mapped to plain wording ("Agent collection", "Mobile Money",
  "Wallet", "Cash").
- Wallet: the tenant's spendable balance via the existing
  `get_user_available_balance(auth.uid())` so the pay sheet can warn before it fails.

No money logic is added or changed. Payment keeps going through the existing
`tenant-pay-rent` edge function, which already posts the balanced ledger legs, calls
`record_rent_request_repayment_v2`, credits agent commission and sends the confirmation
SMS. Nothing is written from the frontend.

## Frontend

- New `src/hooks/useTenantRentPlan.ts` — React Query read of the RPC (30s stale time)
  plus a `usePayRentFromWallet` mutation that invokes `tenant-pay-rent` and invalidates
  the plan, wallet and repayment queries on success.
- `src/pages/TenantRentPlan.tsx` — delete `PLACEHOLDER_PLAN`, feed the existing layout
  from the hook. Layout, styling and copy stay exactly as they are; only the data source
  and the button handlers change:
  - Loading skeleton, and the existing "No active Rent Plan found" state when the RPC
    returns no plan.
  - Quick chips (1 day / 2 days / 1 week / full balance) capped at the outstanding
    balance; amount validated against the wallet balance with an inline message.
  - Confirm Payment calls the mutation, shows a success toast with the reference and the
    new balance, and closes the form. Failures show the server's own reason.

## Technical notes

- Migration applies the RPC only (`CREATE OR REPLACE FUNCTION` + `GRANT EXECUTE ... TO
  authenticated`); no table, policy or trigger changes.
- Regenerate `src/integrations/supabase/types.ts` after the migration.
- Run `npm run guard:all` before finishing.
