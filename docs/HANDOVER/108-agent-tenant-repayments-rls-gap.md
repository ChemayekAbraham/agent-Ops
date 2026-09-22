# 108 — Fourth instance of the same gap: agents can't read `repayments` either

**Built and applied live 2026-09-22.** Before assuming `TenantProfileView.tsx`'s repayment-history
merge (`buildPlanRepaymentHistory`, which queries `repayments` filtered by `tenant_id`) actually
returns data for an ordinary agent — it doesn't.

## What was found

`repayments`' only SELECT policies: `auth.uid() = tenant_id` (self) and a handful of staff roles
(`manager`, `super_admin`, `ceo`, `coo`, `cfo`, `operations`). **No policy lets an agent read their
own tenant's repayments.** `TenantProfileView.tsx` queries this table directly, filtered by
`tenant_id` — for any agent without one of those staff roles (i.e. almost every agent), RLS
silently returns zero rows. The merged payment history on that screen has likely been missing
every `repayments`-only row (self-pay/wallet movements that never produced an `agent_collections`
row) for ordinary agents since it shipped.

This is the same class of gap as doc 105 (`rent_requests`, no `assigned_agent_id` policy) and doc
107 (`landlords`, no owner-identity column) — a fourth table where the web app's own read path
silently degrades for the exact user (an agent viewing their own tenant) it's meant to serve.

## What was built

`get_agent_tenant_repayments(p_tenant_id)` — mirrors the ownership check `get_agent_active_rent_request`
(doc 105) already established (`agent_id`/`assigned_agent_id`/verified `agent_subagents` on any of
the tenant's rent requests), returns the tenant's `repayments` rows (`id`, `rent_request_id`,
`amount`, `created_at`, `payment_method`) if authorized, empty array otherwise — for the native
Android app's payment-history merge (`agent_collections` + `repayments`, replicating
`buildPlanRepaymentHistory`'s dedup/self-paid logic).

## Verified live

- Real agent/tenant pair with 11 real `repayments` rows → RPC returns all 11.
- An unrelated agent on the same tenant → `[]`, not someone else's data.
