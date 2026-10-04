# 121 — Self-applied tenants reach the claim queue; "I approve" tenant-readiness gate

**Built 2026-09-24. NOT YET APPLIED LIVE.** Both migrations and 14 acceptance checks were run on
production inside a transaction that rolled back. The final run passed 13 of 14. The 14th, T14, was a
fixture problem: the "other" service centre manager it picked also holds `tenant_ops`, so they are
a legitimate approver. The gate ships **off**.

P1 items from the 2026-09-24 list:

- **#6 Tenant self-application:** capture GPS and the phone number. Check the tenant's GPS against
  the nearby agent. Support "claim this tenant" and forwarding a claim to another agent.
- **#7 "I approve" for ops roles:** no rent request is approved until the tenant has been trained
  to pay by mobile money themselves and understands their rent top-up access limit. Jen and Grace
  run the training; this records it.

## What we found first

- **The claim queue had been starved since 2026-09-16.** Commit `0bed32f222` made
  `TenantRentRequestCard` redirect to `/tenants-onboarding`. Nothing opens the intake dialog
  anymore, so no new rows reach `tenant_rent_intake_requests`, which is the table the Claim button
  works on. The last intake was on 2026-09-16. Of the 35 intake rows, 29 have no GPS.
- **`/tenants-onboarding` already makes GPS mandatory.** It writes `rent_requests` directly. With
  no referring agent, `agent_id` is NULL, `route_rent_request_service_center` can't route it, and it
  sits in `pending` with nobody to claim it. One such request exists: `c141fcd6…`, from 2026-09-21.
- **`agent_visits` is almost all null-island.** 5,991 of the 6,031 rows in the 30 days to
  2026-09-24 are at (0,0). `user_locations` had no rows at all in that window. Any distance built
  on `agent_visits` is garbage, and **`suggest_nearby_agents` (used by `AssignNearbyAgentDialog`)
  reads it, so it is probably returning garbage today.** Not fixed here; flagged.
- **Notifications are blocked platform-wide.** The `block_notification_inserts` trigger drops every
  type outside a short allowlist. An in-app "tenant forwarded to you" alert would be dropped
  silently, so none is sent. Tenant SMS go through `tenant_rent_intake_notices`, which is
  unaffected.
- **Agents can't move a request from `pending` to `service_center_review`.**
  `guard_rent_request_agent_updates` enforces this even inside SECURITY DEFINER RPCs, because it
  checks `auth.uid()`. The first test run hit it. So a claimed self-applied request stays in
  `pending`.
- All 333 requests funded in the last 30 days had a COO review. No live path skips COO, so gating
  at COO approval breaks nothing. `fund-tenants` can still go from `pending` straight to `funded`,
  but it is unused, and the gate now covers it too.

## #6 — migration `20260924150000_self_applied_tenant_claim_proximity_and_forward.sql`

| Object | What |
|---|---|
| `geo_distance_km(lat1,lng1,lat2,lng2)` | One reusable haversine function (km, 3 dp). Kampala→Entebbe checks out at 31.97 km. |
| `agent_last_known_location(agent)` | Picks the freshest of three live sources: a non-(0,0) `agent_visits` row, a `user_locations` row, or the agent's latest rent-request GPS pin (`rent_request_pin`). If there is none, it falls back to the service centre, then the residence pin. It returns `source` so the UI can say how trustworthy the location is. |
| `tenant_rent_intake_requests` + columns | `source` (`intake_form` or `self_onboarding`), `assigned_agent_distance_km`/`_location_source`, `claim_latitude`/`_longitude`/`_distance_km`, `claim_proximity` (`near` or `far`), and the forward fields (`forwarded_from_agent_id`, `forwarded_by`, `forwarded_at`, `forward_reason`, `forward_count`). There is a unique index on `rent_request_id`. |
| `submit_tenant_rent_intake` | GPS is **mandatory**, and so is a profile phone. It records how far the assigned agent is from the tenant. The signature is unchanged. |
| `tenant_rent_intake_decide` | This is a DROP + CREATE, because the new `p_to_agent_id` parameter would otherwise make an ambiguous overload. Changes: **`claim` requires the claiming agent's live GPS** and stores the distance to the tenant's pin. More than 10 km (`intake_claim_near_km()`) is flagged `far`; it is not blocked. The new **`forward`** action is allowed for the claimer, the assigned agent, or ops. The target must be an enabled, unfrozen agent, and a reason of at least 5 characters is required. It resets the request to `submitted` and assigns it to the target, who must claim it. It records the target's distance and logs a `forwarded` event. For a self-applied request, `claim` sets `rent_requests.agent_id` (only while it is `pending` and agentless), and `forward` clears it again. `approve` goes straight to `rent_requested`, because the rent request already exists. |
| `enqueue_rent_request_for_claim` + `trg_enqueue_agentless_rent_request` | An AFTER INSERT trigger: any new `pending` rent request with no agent gets a `self_onboarding` intake row. The row carries the tenant phone, the landlord, the GPS, the nearest centre, and the assigned agent's distance. Failures are logged to `system_events` and never block the insert. It backfills the one existing request. |

The locks are taken up front in a fixed order. The first dry run deadlocked against live readers:
it altered the intake table first, then touched `rent_requests`.

In the test run, the backfilled tenant pinned near Mbale was **183 km** from the agent that
nearest-centre routing assigned, going by that agent's latest real pin. This is exactly the
mismatch the proximity check exists to show.

## #7 — migration `20260924150100_tenant_payment_readiness_approval_gate.sql`

| Object | What |
|---|---|
| `rent_request_tenant_readiness` | One row per "I approve". Both `momo_self_pay_trained` and `access_limit_understood` are CHECKed true. It stores `trained_by_name` (Jen or Grace), a snapshot of `credit_access_limits.total_limit`, `attested_by`, `attested_role`, and a revoke trio. Rows are read under RLS; writes happen only through the RPCs. |
| `tenant_readiness_approver_role(user)` | Returns `tenant_ops`, `landlord_ops`, `agent_ops` or `service_center_manager`, else NULL. |
| `record_tenant_payment_readiness(rr, trained, understood, trained_by, note)` | This is the button. Both confirmations are required. A service centre manager may only approve requests routed to them (`service_center_manager_id`), because `is_service_center_manager` is broad: it includes any agent with a verified sub-agent. Closed requests are refused. |
| `revoke_tenant_payment_readiness(id, reason)` | Undoes a mistaken approval, with a reason of at least 10 characters. After a revoke, the gate blocks the request again. |
| `trg_enforce_tenant_readiness_before_approval` | Blocks entry into `coo_approved`, `approved`, `funded`, `disbursed` or `repaying` from any pre-approval status unless an unrevoked readiness row exists. The error is `TENANT_NOT_READY`. The earlier ops stages stay open, so the button can be pressed at whichever stage the training happens. Requests already past COO are unaffected. |
| `treasury_controls.enforce_tenant_readiness_gate` | Starts `false`. |

**Turn the gate on only after the button is on screen**; otherwise COO is blocked with no way
forward:

```sql
UPDATE treasury_controls SET enabled = true, updated_at = now()
 WHERE control_key = 'enforce_tenant_readiness_gate';
```

When it's on, about 3,900 queued requests (`service_center_review` + `pending`) will each need an
"I approve" before COO can approve them. That is the intended rule.

## Frontend (logic only)

- `src/hooks/useTenantPaymentReadiness.ts`: `useTenantPaymentReadiness(rrId)`,
  `useTenantPaymentReadinessMap(ids)` for pipeline lists, `useTenantReadinessApproverRole()`,
  `useTenantReadinessGateEnabled()`, `useRecordTenantPaymentReadiness()`,
  `useRevokeTenantPaymentReadiness()` and `isTenantNotReadyError(e)`.
- `TenantRentIntakeQueue.tsx`: `act()` now captures GPS for `claim`, warns when a claim is `far`,
  and supports `act(id, 'forward', { toAgentId, reason })`. The query selects the new columns.
- `TenantRentRequestCard.tsx`: `submit` refuses without a pin (the server does too).

## Handed to Gemini (UI)

1. **"I approve" button + dialog.** Show it in `RentPipelineQueue` and the service centre review for
   users with an approver role. It needs two checkboxes: "Trained to pay by themselves with mobile
   money" and "Understands their rent top-up access limit (show `access_limit`)". It also needs a
   "Trained by" field (Jen or Grace) and an optional note. Show a readiness badge on each row
   (via `useTenantPaymentReadinessMap`). Show the `TENANT_NOT_READY` error nicely on the COO
   approve action.
2. **Forward** control in `TenantRentIntakeQueue`: an agent picker plus a reason, calling
   `act(r.id, 'forward', …)`.
3. **Proximity display** in the queue: `claim_distance_km`/`claim_proximity`,
   `assigned_agent_distance_km` + `assigned_agent_location_source`, a "Forwarded from … : reason"
   line, and a "Self-applied" badge when `source = 'self_onboarding'`. Make the tenant phone
   prominent. It is already in the row, but it's a small outline button.

## Open

- `suggest_nearby_agents` still uses null-island `agent_visits`. It should switch to
  `agent_last_known_location`.
- Whatever writes (0,0) into `agent_visits` should write NULL or refuse. That writer was not traced
  here.
- The intake table's RLS UPDATE policy ("Assigned agents update routed rent intake requests") lets
  agents edit rows directly, including the new claim-distance columns. The RPC is the intended
  path; tightening that policy is a follow-up.
- A self-applied request that is claimed stays in `pending`, so it skips service-centre review
  (see the guard above). The claim plus the site visit stand in for it.
