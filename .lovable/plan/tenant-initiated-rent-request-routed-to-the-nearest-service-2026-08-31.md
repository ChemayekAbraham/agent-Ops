# Tenant-initiated rent request routed to the nearest Service Centre

A tenant can ask for rent help themselves. The request is not a rent plan — it is an intake that lands with the nearest Welile Service Centre, where an assigned agent verifies the tenant and the house. Only after the agent approves does the agent raise the actual rent request through the existing pipeline, so nothing about the rent-request approval chain changes.

## What the tenant sees

New card on the tenant dashboard, directly under the "Find a house nearby" button:

- Title "Request rent as tenant", one short line of explanation, and a button that opens a short form.
- Form (minimal, per your choice): rent amount, house location (village picker + captured GPS), landlord name and phone, optional note.
- On submit: confirmation showing which Service Centre it went to and that an agent will visit to verify the tenant and the house.
- If the tenant already has an open request, the card shows its status (Submitted → Agent assigned → Visit done → Approved / Declined) instead of the form.

## What the agent sees

New "Tenant requests" queue inside the existing Agent Service Centre screen, in the Vetting tab group next to Rent, Houses, Landlords, LC1:

- List of requests assigned to that agent's Service Centre with tenant name, phone, location, rent amount, landlord contact, distance and age.
- Actions: Claim, Call/WhatsApp, "Verify visit" (captures GPS via the existing trust-signal path), Approve, Decline with reason.
- Approving marks the intake approved and surfaces a "Raise rent request" action that opens the existing agent rent-request dialog pre-filled from the intake. The rent plan itself is created only by that existing flow.

## Routing

Nearest verified Service Centre by straight-line distance from the tenant's captured location, always assigned even if far (no coverage block). Assigned agent is the centre's agent, or a currently-assigned agent from the centre's agent assignments when present. Distance and chosen centre are stored on the request for audit.

## Technical notes

- New table `tenant_rent_intake_requests` (tenant_id, phone, rent amount, location text + lat/lng, village/district, landlord name/phone, note, service_centre_id, assigned_agent_id, distance_km, status, claimed/visited/decided actors + timestamps, decline reason, resulting rent_request_id, timestamps + update trigger) with GRANTs for `authenticated` and `service_role`, RLS enabled: tenant reads/creates own rows; assigned agent and ops/executive roles read and update theirs; no deletes.
- New table `tenant_rent_intake_events` for the append-only trail (created, assigned, claimed, visit_verified, approved, declined, rent_request_raised).
- Nearest-centre selection and insert done in one SECURITY DEFINER RPC (`submit_tenant_rent_intake`) so the client makes a single atomic call; agent actions go through `tenant_rent_intake_decide`. Both emit a `system_event` and a trust signal via `capture_trust_signal`, per the trust mandate.
- Frontend: `src/components/tenant/TenantRentRequestCard.tsx` (card + dialog + status), mounted in `TenantDashboard.tsx` right after `FindAHouseCTA`; `src/components/agent/service-center/TenantRentIntakeQueue.tsx` plus a hook, added as a new sub-tab in `src/pages/AgentServiceCenter.tsx`. The disabled tenant self-serve `RentRequestButton` / `RentRequestForm` stay untouched.
- No change to `rent_requests` statuses, the approval chain, wallets, or the ledger.
