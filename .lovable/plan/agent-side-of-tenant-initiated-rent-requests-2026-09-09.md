# Agent side of tenant-initiated rent requests

The tenant side is live and 18 real requests are already sitting at "New", all routed to a Service Centre and an agent. The agent queue exists inside Agent Service Centre → Vetting → "Tenant requests" with Claim, Verify house at site, Approve and Decline working against the existing routing rules. What is missing is the last mile and the visibility, and that is what this adds. Frontend only — no database, money, or approval-rule changes.

## What agents will get

1. **Raise the rent plan straight from an approved request.** Today an approved request just shows a sentence telling the agent to go and raise it elsewhere. Instead, an approved card gets a "Raise rent request" button that opens the normal agent rent request form, already filled with the tenant's name, phone and rent amount. When that form completes, the request moves to "Rent plan raised" and the tenant's tracker updates on its own.

2. **They notice the requests.** The "Tenant requests" tab gets a count of open requests, and the Service Centre page shows a small alert when new unclaimed requests are waiting.

3. **The queue is workable with 18+ rows.** Filter chips for New / Mine / Approved / Closed, newest and nearest first, an age label ("2 days waiting"), and the tenant's shared-location badge so the agent knows whether GPS was captured before travelling. Search stays as it is.

4. **Clearer card actions.** Claim before Verify (Verify only after claiming, matching the rules the server already enforces), a WhatsApp button next to each Call button, and the tenant's note and distance kept visible.

## Technical notes

- `src/components/agent/TenantRentIntakeQueue.tsx`: add filter state, ordering, age/GPS badges, WhatsApp links, and an approved-row "Raise rent request" action that mounts `AgentRentRequestDialog` with `prefillTenantName` / `prefillTenantPhone` / `prefillRentAmount`. On its `onSuccess`, call the existing `tenant_rent_intake_decide` RPC with `p_action: 'link_rent_request'` and the new rent request id, then invalidate `['tenant-rent-intake-queue']`.
- To get that id, read the agent's newest `rent_requests` row for the tenant after the dialog succeeds (matched on `tenant_id` + `agent_id` + `created_at`), rather than changing the dialog's contract.
- Export a small `useTenantRentIntakeQueue` hook from the same file so `src/pages/AgentServiceCenter.tsx` can show the tab count and the alert without a second query (shared React Query key).
- No change to `submit_tenant_rent_intake`, `tenant_rent_intake_decide`, RLS, the rent request pipeline, wallets, or the ledger.
