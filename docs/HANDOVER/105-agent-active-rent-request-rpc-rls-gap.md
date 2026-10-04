# 105 — New RPC: `get_agent_active_rent_request()`, and a real RLS gap it routes around

**Built and applied live 2026-09-22.** Before touching `get_agent_active_rent_request`, or
having a client (native app, or any future direct-query code) call
`.from('rent_requests').select(...)` expecting to see a tenant assigned to an agent only via
`assigned_agent_id`.

## The gap

`rent_requests`' only agent-facing RLS SELECT policy is `"Agents view requests they registered"`:
`auth.uid() = agent_id`. There is **no policy for `assigned_agent_id`**. Every existing RPC that
needs to work for assigned agents too (`agent_allocate_tenant_payment`, `get_agent_tenants_overview`,
`get_agent_tenant_profile`) is `SECURITY DEFINER` and checks `agent_id = auth.uid() OR
assigned_agent_id = auth.uid()` (plus a verified-subagent check) itself, bypassing RLS entirely.
`TenantProfileView.tsx` gets away with a direct client-side `.from('rent_requests').select(...)`
today only because RLS silently returns whatever subset it's allowed to see — for a tenant assigned
via `assigned_agent_id` only, that would be **zero rows**, not an error, so this has likely been
silently producing incomplete data for exactly that agent/tenant combination in the web app too.
Not fixed here (out of scope — this migration only adds a new, correctly-scoped RPC for the native
app) but worth someone confirming whether `TenantProfileView.tsx`'s `activeRequest`/`requests` list
ever actually breaks for an assigned-agent-only tenant.

## What was built

`get_agent_active_rent_request(p_tenant_id)` — mirrors the exact ownership check
`agent_allocate_tenant_payment`'s wrapper already uses (`agent_id`/`assigned_agent_id`/verified
`agent_subagents` relationship), and replicates `TenantProfileView.tsx`'s `activeRequest` selection
logic precisely: among a tenant's rent requests (newest first), the first one in
`('approved','funded','disbursed','repaying')` that still owes money, or — only if none qualify —
the first `'rejected'` `outstanding_balance` row that still owes money. Returns
`{found, id, status, total_repayment, amount_repaid, outstanding, registration_type,
repayment_starts_on, daily_repayment}`.

Built for the native Android app's upcoming collect-payment feature — it needs the specific
`rent_request_id` to pass to `agent_allocate_tenant_payment`, and a direct client query would have
had the same silent-gap problem for assigned-agent tenants.

## Verified live

Found a real rent request (`agent_id` ≠ `assigned_agent_id`) and confirmed:
- Calling as the **assigned** agent (not the registering `agent_id`) → finds the plan correctly
  (`funded`, UGX 209,500 outstanding) — the case a direct RLS-limited query would have missed.
- Calling as an unrelated third agent → `{found: false}`, not someone else's plan.
