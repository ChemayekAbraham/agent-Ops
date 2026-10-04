# Plan B — Agent operations, transfers, locations, LC letter

## Part 1 — Listings go through the Service Centre first

Today an agent's house listing goes straight to the Landlord Ops verification queue. We insert a Service Centre vetting step in front of it, mirroring what rent requests now do.

- New listing state: a listing created by an agent who is attached to a Service Centre manager lands as "awaiting service centre" instead of appearing in the Landlord Ops queue.
- The Service Centre manager sees these in a new "House listings" tab in the vetting area, with photos, address, GPS, landlord and rent. Two actions: pass to Landlord Ops, or return to the agent with a mandatory reason.
- Only after the manager passes it does it appear in Landlord Ops. Landlord Ops remains the final verifier and the only place the verification bonus is paid.
- Listings from agents with no Service Centre manager keep the current direct route, so nothing stalls.
- Returned listings show the reason to the agent and can be corrected and resubmitted.

## Part 2 — "Could not load payment history"

Cause: the payment-history query only authorises the parent agent, a direct sub-agent, the named Service Centre manager, or an ops role. Tenants that sit under a nested sub-agent (a sub-agent of a sub-agent) or under a plan whose Service Centre manager field is empty fail the check and the panel prints the generic message.

Fix:
- Widen the authorisation to the whole downline tree, not just the first level, and to the manager who is resolved for the agent (not only the value stamped on the row).
- Show the real reason in the panel instead of one flat sentence, with a Retry button.

## Part 3 — Tenant transfers must be verified by Agent Ops

The request and decision plumbing already exists. The gap is the queue, the reason discipline and the record move.

- Agent Ops gets a "Tenant transfers" queue: sending agent, receiving agent, tenant, plan, amount collected so far, reason given, waiting time.
- Approve requires a reason of at least 10 characters. Reject requires the same.
- On approval, in one transaction: the plan's agent is changed to the receiving agent, and the tenant's collection and repayment records, active tasks, targets and daily eligibility follow the plan so the receiving agent inherits the full history. The sending agent keeps historical commission already earned.
- The tenant stays visibly "pending transfer" on both sides until Agent Ops decides.

## Part 4 — Uganda location dataset (village / parish / sub-county / county / district)

- One reference table holding the full hierarchy with parent links, plus a search index on names. Loaded once from your dataset.
- A single reusable location picker: type a village, get the full chain filled in automatically; or drill down district → county → sub-county → parish → village.
- Rent requests, house listings, landlords and profiles store the selected village id alongside the free text they store today, so old records stay readable and new ones are precise.
- Reports and ops filters can then group by any level without string matching.

To load it, please attach the dataset in chat (CSV or Excel). I will map the columns and import it.

## Part 5 — LC letter upload on the Officials tab

- In the rent request dialog's Officials step, one image upload for the LC letter: .jpg, .jpeg, .png only, maximum 10 MB, exactly one file, with preview and replace.
- Stored in a private bucket; viewers open it through a short-lived signed link. The path is saved on the rent request so the Service Centre, Agent Ops and Landlord Ops can all open the letter during vetting.

## Technical notes

- Listings: add `service_center_manager_id`, `service_center_status`, `service_center_reviewed_at/by`, `service_center_comment` to `house_listings`; a routing trigger mirroring `route_rent_request_service_center`; RPC `service_center_review_house_listing(p_listing_id, p_decision, p_comment)`; extend `get_service_center_rent_queue` or add `get_service_center_listing_queue`; Landlord Ops queries filter on the passed state.
- Payments: replace the authorisation branch in `get_service_center_tenant_payments` with a recursive downline CTE over `agent_subagents` plus `resolve_service_center_manager_for_agent`; surface `error.message` in `ServiceCenterTenantPayments.tsx`.
- Transfers: build the queue on `ops_list_subagent_tenant_transfers`; harden `ops_decide_subagent_tenant_transfer` to reassign `rent_requests.agent_id`, `agent_collections.agent_id` for that plan, open `agent_tasks`, and emit a `system_event`; require reason length server-side.
- Locations: `ug_locations` (id, level, name, parent_id, district/county/subcounty/parish denormalised, `search_tsv`), GRANTs for anon/authenticated read only; `search_ug_locations(p_query, p_limit)`; nullable `village_id` FKs on the consuming tables.
- LC letter: private `lc-letters` bucket, RLS on `storage.objects` scoped to the uploading agent plus ops roles, `lc_letter_path`/`lc_letter_bucket` on `rent_requests`, signing helper reused from `payoutProof`.

## Sequencing

1. Part 2 (small fix) and Part 5 (upload) — quick wins.
2. Part 1 listings vetting.
3. Part 3 transfer verification and record move.
4. Part 4 locations, once the dataset file is attached.
