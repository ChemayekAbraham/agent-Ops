---
name: Agent Ops 1M+ Scale Architecture
description: Server-side aggregation + paginated RPC pattern for Agent Ops dashboards (Balances + Directory) supporting 1M+ agents
type: feature
---
The Agent Ops dashboards (Balances, Directory) are built for 1,000,000+ agents using server-side RPCs that NEVER transfer all rows to the client.

**Pattern (per dashboard):** one `*_totals()` RPC returning a single aggregate row + one `*_rows(_search, _sort, _limit, _offset, ...)` RPC returning a paginated/sortable/searchable slice with `total_matched` via window function. Both invoked in parallel from a permission-gated edge function.

**Agent Balances** (`agent-ops-balances` edge fn):
- `get_agent_ops_totals()` — count + total withdrawable/float/advance/held + bucket-presence counts.
- `get_agent_ops_balances(_search, _sort, _limit, _offset)` — sort whitelist: total/withdrawable/float/advance/name. Limit clamped to 200.
- Client: `AgentBalancesPanel.tsx`, 50/page, 300ms debounced search, server sort, `keepPreviousData`.

**Agent Directory** (`agent-directory` edge fn):
- `get_agent_directory_totals()` — total/verified/withTerritory/active30d/new30d counts.
- `get_agent_directory_rows(_search, _sort, _verified_only, _limit, _offset)` — search by name/phone/email/territory/ID, sort whitelist: name/recent/active/territory. Limit clamped to 200.
- Client: `AgentDirectory.tsx`, 50/page, 300ms debounced search, server sort, `keepPreviousData`. Replaces a previous client-side approach that pre-loaded all agent IDs.
- Indexes added: `lower(full_name)`, `lower(email)`, `lower(territory)`, `last_active_at`, `created_at`, composite `user_roles(role, user_id)`.

**Edge function permission gate (both):** validates auth, then requires manager/coo/super_admin/cto role OR `staff_permissions.permitted_dashboard IN (agent, agent-ops, agent_ops)`. RPCs are SECURITY DEFINER with EXECUTE revoked from public/anon/authenticated — only callable via the service-role edge function.

**Why:** Previous client-side approaches (batch-loading IDs, ilike on profiles) hit URL-length and memory limits past ~1000 agents and could not produce platform-wide totals without loading every row. Server-side SQL aggregation scales linearly with indexes and never sends the full agent set over the wire. Totals always reflect ALL agents regardless of current page or filters.
