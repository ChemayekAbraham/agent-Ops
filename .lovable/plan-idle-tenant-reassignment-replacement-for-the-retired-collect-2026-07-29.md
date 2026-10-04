# Idle Tenant Reassignment — replacement for the retired collection lock

## Why the old lock failed

The previous system flipped `rent_requests.collection_locked_at` and a
`BEFORE INSERT` trigger on `agent_collections` blocked every payment attempt
with "Tenant is locked from collection…". Two problems:

1. It punished the tenant (nobody can collect) to punish the agent.
2. Cadence classification was fragile — one bad row locked real paying
   tenants (NATUHWERA FLAVIA, NASEJJE MAGRET).

The new design never blocks a collection. It moves the tenant to a more
active agent, with a consent window for the current agent.

## Model

```text
  day 0 — last collection
   |
   |- +5d   WARN            push + SMS to agent, chip on tenant tile
   |- +8d   AT RISK         appears in Agent Ops "Idle Tenants" queue
   +- +12d  REASSIGN READY  one-click transfer to a nearby active agent
```

No trigger, no hard lock. Collections stay open the whole time. If the
original agent collects on day 11 the tenant drops back to healthy and the
queue entry auto-clears.

Cadence per tenant: `subscription_charges.frequency` first, else median gap
of the last 5 collections. Weekly tenants get 2x thresholds (10 / 15 / 20).
Unknown cadence -> warn only.

## Data

New table `tenant_idle_states` (one row per active `rent_requests.id`):

- rent_request_id, tenant_id, agent_id
- cadence (`daily` | `weekly` | `unknown`)
- last_collection_at, days_idle
- state (`healthy` | `warn` | `at_risk` | `reassign_ready`)
- warned_at, at_risk_at, reassign_ready_at
- resolved_at, resolved_by

Rebuilt by a 15-min cron from `agent_collections` + `rent_requests`. Never
written from the payment path — payments only insert `agent_collections`
and the next cron tick clears the row.

## Reassignment flow

RPC `agent_ops_reassign_idle_tenant(rent_request_id, new_agent_id, reason)`:

1. Caller must have `agent_ops` / `coo` / `manager` role.
2. Target agent must be active (collected in last 3 days) and in the same
   sub-county.
3. Moves `assigned_agent_id` on `rent_requests`, writes
   `tenant_reassignment_audit` (old agent, new agent, reason, actor).
4. Fires `system_event: tenant.reassigned` -> SMS to both agents and tenant.

Original agent keeps commission already earned. Future collections credit
the new agent.

## UI

- Agent Dashboard: yellow "At risk" chip at day 5, red "Pending
  reassignment" chip at day 8 — never an error dialog.
- Agent Ops -> new tab **Idle Tenants**: table of at-risk and
  reassign-ready rows with one-click "Reassign to nearest active agent"
  and manual override picker.
- Removes the retired lock banner/error entirely.

## Notifications

- Day 5: push + SMS to agent ("Collect from X or they will be transferred.").
- Day 8: push + line item in Agent Ops daily report.
- Day 12: SMS to old agent, new agent, and tenant on reassignment.

## Rollout

1. Migration: create `tenant_idle_states`, `tenant_reassignment_audit`,
   `agent_ops_reassign_idle_tenant` RPC, and the 15-min cron.
2. Edge fn `refresh-tenant-idle-states` (called by cron; also
   invalidatable by webhook after big collections).
3. UI: dashboard chips, Agent Ops queue, remove residual error strings.
4. Backfill idle state for all active tenancies once.
5. Deprecate columns `collection_locked_at`, `collection_locked_reason`,
   `collection_lock_days` after one clean week (kept for audit).

## Technical notes

- `subscription_charges.frequency` remains the primary cadence source;
  median-gap fallback capped at 5 rows.
- Cron `*/15 * * * *` invokes the edge fn with a service-role key.
- RPC is `SECURITY DEFINER` with `SET search_path = public` and role checks
  via `has_role`.
- All three tables carry standard `service_role` + role-scoped grants.
- No changes to `agent_collections`, `general_ledger`, or wallet paths.
