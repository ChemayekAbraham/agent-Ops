# Post Rent Request — Dashboard Flow and Verification Map

Audience: operations, executive and finance reviewers.
Purpose: show exactly where each rent request sits, who opens which dashboard to act on it, and what information that reviewer is expected to check before approving.

All statuses, routes, components, RPCs and edge functions below were read from the live database and the current source. Nothing is inferred.

---

## 1. Master flow chart

```text
                        AGENT SUBMITS POST RENT REQUEST
                     (AgentRentRequestDialog -> rent_requests)
                                     |
                     BEFORE INSERT: trg_route_rent_request_service_center
                                     |
                 +-------------------+--------------------+
                 |                                        |
     agent has a Service Center Manager        agent has no Service Center Manager
                 |                                        |
                 v                                        |
       [ service_center_review ]                           |
       Service Center Manager vets                          |
                 |                                        |
         verify  |  reject -> [ rejected ]                 |
                 +-------------------+--------------------+
                                     |
                                     v
                              [ pending ]
                        STAGE 1 - Agent Ops Review
                                     |
                                     v
                        [ agent_ops_approved ]
                        STAGE 2 - Tenant Ops Review
                                     |
                                     v
                       [ tenant_ops_approved ]
                       STAGE 3 - Landlord Ops Review
                       (landlord call checklist, UGX 5,000 bonus)
                                     |
                                     v
                      [ landlord_ops_approved ]
                        STAGE 4 - COO Approval
                                     |
                                     v
                          [ coo_approved ]
                   STAGE 5 - CFO Payout Authorization
                   (edge function: fund-agent-landlord-float)
                                     |
                                     v
                            [ funded ]
                 agent receives landlord float, pays landlord
                                     |
                                     v
                           [ repaying ]
                  daily repayment collected from tenant
                                     |
                                     v
                           [ completed ]

  At ANY stage 1-5 a reviewer may:
      Reject            -> [ rejected ]  (agent sees reason, may resubmit)
      Return for fix    -> RPC return_rent_request_for_correction
  Agent may withdraw own in-review request -> [ deleted_by_agent ]
```

### Description

A post rent request is not a single approval. It is a five-desk relay where each desk verifies a different risk, and only the last desk moves money. The chain is deliberately linear: a request cannot skip a desk, because each desk's approve button hard-codes the next status. Money enters the chain only at Stage 5, and only through an edge function that refuses to run twice on the same request.

Sub-agent requests are additionally pre-vetted by their own Service Center Manager before they are allowed to consume company review time. That routing happens in the database on insert, not in the app, so it cannot be bypassed by the submitting client.

---

## 2. Live status distribution (all time, at time of writing)

| Status | Rows | Meaning |
|---|---|---|
| repaying | 578 | Funded and being collected |
| completed | 402 | Fully repaid |
| pending | 196 | Sitting at Agent Ops desk |
| rejected | 193 | Rejected at some desk |
| funded | 91 | Money released, collection not yet started |
| deleted_by_agent | 83 | Withdrawn by the agent |
| coo_approved | 70 | Waiting on CFO payout authorization |
| agent_ops_approved | 3 | Waiting on Tenant Ops |
| cancelled | 2 | Legacy terminal state |

Reading of that table: the two real congestion points today are `pending` (196 at Agent Ops) and `coo_approved` (70 waiting on CFO money release). Tenant Ops and Landlord Ops are effectively clear, which means requests are queueing at the entry desk and again at the cash desk, not in the middle of the chain.

Full permitted status set (DB constraint `rent_requests_status_check`): `pending, service_center_review, approved, rejected, cancelled, deleted_by_agent, agent_ops_approved, tenant_ops_approved, agent_verified, landlord_ops_approved, coo_approved, funded, disbursed, repaying, fully_repaid, defaulted, completed`.

---

## 3. Stage 0 — Submission

```text
Agent dashboard -> Rent tab -> "Post Rent Request"
   -> tenant passport photo uploaded FIRST (DB trigger blocks photo-less inserts)
   -> insert into rent_requests (status 'pending')
   -> house linked, house photos, LC letter attached after insert
```

**Where:** `/dashboard/agent`, Post Rent Request dialog (`src/components/agent/AgentRentRequestDialog.tsx`).

**What is captured and therefore what every later desk can rely on:** tenant, landlord, LC1 chairperson, rent amount, duration in days, access fee, request fee, total repayment, daily repayment, house category, GPS latitude/longitude (mandatory), tenant photo, house photos, LC letter file, agent guarantor consent, preferred language, whether the tenant has no smartphone, and for arrears cases the registration type plus opening outstanding balance.

**Automatic gates that fire before the row exists:** agent daily eligibility, agent exposure capacity, duplicate-request block, landlord-must-be-registered, landlord-verified-before-approval, rent formula enforcement, tenant photo required.

### Description
A submission that reaches a reviewer has already passed seven database gates. If an agent complains their request "disappeared", the correct first question is which gate rejected the insert, not which desk rejected the request.

---

## 4. Stage 0b — Service Center vetting (sub-agents only)

```text
[ service_center_review ]
     verify -> back to [ pending ], enters the company pipeline
     reject -> [ rejected ], never consumes company review time
```

**Who acts:** the sub-agent's Service Center Manager (a senior agent), not company staff.

**Where they go:** `/agent/service-center`, panel "Rent request vetting".

**Access rule:** the signed-in user must be the `service_center_managers.agent_id` for that sub-agent, or hold an ops role. Managers only see their own sub-agents' requests.

**What they are expected to verify:** that the tenant and house are real and known to them, that the rent figure matches what the landlord actually charges, and that the sub-agent is not padding volume. This is a field-truth check, not a documents check.

**System effect:** decision is recorded through RPC `service_center_review_rent_request` and emits a `system_events` row (`rent_request.service_center_verified` or `.service_center_rejected`).

---

## 5. Stage 1 — Agent Ops Review

```text
[ pending ] --approve--> [ agent_ops_approved ]
```

**Where the admin goes:** `/executive-hub?tab=agent-ops`, card titled "Agent Ops Review".

**Access:** `staff_permissions` key `agent-ops` (or bypass roles `super_admin` / `cto`).

**Button:** "Approve & Forward to Tenant Ops". Writes `agent_ops_reviewed_by`, `agent_ops_reviewed_at`, `agent_ops_comment`.

**Information the reviewer is expected to check:**
- The submitting agent: who they are, their phone, their current exposure and repayment behaviour.
- Rent amount against house category and area — is the figure plausible for that kind of property?
- GPS point and city — does the location match the stated area?
- Tenant photo present and legible.
- House photos present.
- Duplicate risk: same tenant or same house already in the pipeline.

**Description:** this desk answers one question — is this agent submitting a real, sane deal? It is the volume filter, which is why 196 requests sit here. Everything downstream assumes this check happened.

---

## 6. Stage 2 — Tenant Ops Review

```text
[ agent_ops_approved ] --approve--> [ tenant_ops_approved ]
```

**Where the admin goes:** `/executive-hub?tab=tenant-ops`, card titled "Tenant Ops Review".

**Access:** `staff_permissions` key `tenant-ops`.

**Button:** "Approve & Forward to Landlord Ops". This stage also carries a **collecting-agent selector** — the reviewer assigns `assigned_agent_id`, i.e. who will actually collect daily repayments. Writes `tenant_ops_reviewed_by/at/comment`.

**Information the reviewer is expected to check:**
- Tenant identity and contactability: full name, phone, national ID, village/parish/district.
- Tenant photo against the submitted details.
- Affordability: `daily_repayment` versus what this tenant can realistically pay, and `total_repayment` versus `rent_amount`.
- Duration in days and whether it matches the tenancy.
- The Agent Ops note left at Stage 1 (surfaced read-only on the card).
- Which agent should own collection for this tenant's location.

**Description:** this is the credit desk. It is the only stage that decides who carries the collection relationship, so a wrong assignment here shows up later as an uncollected tenant, not as a rejected request.

---

## 7. Stage 3 — Landlord Ops Review

```text
[ tenant_ops_approved ] --approve--> [ landlord_ops_approved ]
                                     + UGX 5,000 landlord-verification bonus to agent
```

**Where the admin goes:** `/executive-hub?tab=landlord-ops`, card titled "Landlord Ops Review".

**Access:** `staff_permissions` key `landlord-ops`.

**Button:** "Approve & Forward to COO" — blocked until the inline checklist is complete.

**Mandatory checklist (enforced, not advisory):**
1. Landlord called (`landlord_called`).
2. Landlord acknowledged the tenant and the rent figure (`landlord_acknowledged`).
3. Verification method recorded (`landlord_verification_method`, defaults to `phone_call`).
4. Call notes (`landlord_call_notes`).

Checklist ticks auto-save per request and per reviewer, so a reviewer can start on one device and finish on another.

**Information the reviewer is expected to check:**
- Landlord name, phone, mobile money number, property address, district/sub-county/village — opened via the landlord drilldown on the card.
- LC1 chairperson name, phone and village as an independent confirmation of the landlord.
- The LC letter attachment.
- That the landlord's payout number is the landlord's, not the agent's.
- Earlier Agent Ops and Tenant Ops notes.

**Side effects:** on approval the app invokes `credit-landlord-verification-bonus` (UGX 5,000 to the agent) and writes an approval audit entry recording whether the bonus succeeded. Arrears cases (`registration_type = 'outstanding_balance'`) skip both the checklist and the bonus, and the audit entry records "No bonus applicable".

**Description:** this is the fraud desk. It is the last point at which a fabricated landlord can be caught before the COO and CFO treat the deal as real. It is also the only mid-pipeline stage that pays money out, which is why its audit trail is separate.

---

## 8. Stage 4 — COO Approval

```text
[ landlord_ops_approved ] --approve--> [ coo_approved ]
```

**Where the admin goes:** `/coo/dashboard`, card titled "COO Approval" (with "Rejected at COO" beneath it).

**Access:** route guard roles `coo`, `super_admin`, `cto`, plus permission key `coo`.

**Button:** "Approve & Forward to CFO". Writes `coo_reviewed_by`, `coo_reviewed_at`, `approval_comment`.

**Information the reviewer is expected to check:**
- The complete three-note trail from Agent Ops, Tenant Ops and Landlord Ops — a thin or copy-pasted note is the signal to send it back.
- Whether the landlord verification checklist was genuinely completed.
- Portfolio fit: exposure to this agent, this area, this rent band.
- Total repayment and daily repayment as finally edited.

**Description:** the COO is not re-verifying facts. The COO is auditing whether the three desks below did their jobs, and is the correct place to stop a deal that is individually clean but wrong for the book.

---

## 9. Stage 5 — CFO Payout Authorization

```text
[ coo_approved ] --authorize--> [ funded ]
   requires transaction reference + payout method
   invokes edge function fund-agent-landlord-float
```

**Where the admin goes:** `/cfo/dashboard`, card titled "CFO Payout Authorization"; the same stage is also worked from the Rent Disbursement Queue on that dashboard.

**Access:** route guard roles `cfo`, `super_admin`, `cto`, plus permission key `cfo`. The edge function independently re-checks the caller holds `cfo`, `manager` or `super_admin`.

**Button:** "Authorize & Fund Agent Float". The button will not fire without a transaction reference.

**What the CFO must supply and check:**
- Payout method and the actual transaction reference of the money sent.
- The landlord's mobile money number.
- The amount to be released against `rent_amount`.
- Whether this request already has a live float allocation.

**What the system does:** creates an `agent_landlord_float_allocations` row (agent, tenant, landlord, landlord phone, allocated amount, source `cfo_disbursement`) with a duplicate-allocation guard, and moves the request to `funded`. If the request is already `funded` the function returns a 409 and refuses — double funding is not possible by retrying.

**Description:** this is the only desk where company cash leaves. Everything before it is paperwork; this step converts an approved request into agent float that must be physically handed to the landlord.

---

## 10. After funding

```text
[ funded ] -> agent pays landlord -> [ repaying ] -> daily collections -> [ completed ]
```

**Where it is monitored:**
- Agent side: agent dashboard rent section, "My rent requests" sheet, status tracker.
- Tenant side: repayment section and repayment history.
- Finance side: `/cfo/dashboard` receivables tracker and financial overview.
- Agent Ops side: `/executive-hub?tab=agent-ops` daily collection and eligibility views.

**What is expected to be watched:** whether daily collections are actually landing for each funded tenant, arrears building on a specific agent, and requests stuck in `funded` without collections starting — that pattern means the landlord may never have been paid.

---

## 11. Rejections, corrections and resubmission

```text
any stage --reject--> [ rejected ]  (reason + stage stored, WhatsApp sent to agent)
any stage --return---> RPC return_rent_request_for_correction (agent fixes, no rejection)
agent      --withdraw--> [ deleted_by_agent ]
[ rejected ] --RPC agent_resubmit_rent_request--> [ pending ]
```

**Where each desk sees its own rejections:**

| Desk | Route | Panel |
|---|---|---|
| Agent Ops | `/executive-hub?tab=agent-ops` | "Rejected — Correction Desk (all stages)" |
| Tenant Ops | `/executive-hub?tab=tenant-ops` | "Rejected at Tenant Ops" |
| Landlord Ops | `/executive-hub?tab=landlord-ops` | "Rejected at Landlord Ops" |
| COO | `/coo/dashboard` | "Rejected at COO" |
| CFO | `/cfo/dashboard` | "Rejected at CFO" |

On rejection the system stores `rejected_at`, `rejected_reason`, `rejected_at_stage`, and automatically opens a WhatsApp message to the submitting agent containing the stage, the tenant contact, the amount and the reason. If the agent has no phone on file the reviewer is warned that no message was sent.

Resubmission runs through RPC `agent_resubmit_rent_request`, which merges the corrected fields, recalculates access fee, total repayment and daily repayment, increments `reopen_count`, clears the rejection metadata, records `resubmitted_at` and the agent's note, and returns the request to `pending`. A resubmitted request re-enters at Agent Ops, and because service-center routing only fires on insert, a resubmit does not go back to the Service Center Manager.

---

## 12. One-page dashboard cheat sheet

| Stage | Status in DB | Who acts | Exact destination | Access key/role | Decision output |
|---|---|---|---|---|---|
| 0b | `service_center_review` | Service Center Manager | `/agent/service-center` | own sub-agents, or ops role | back to `pending`, or `rejected` |
| 1 | `pending` | Agent Ops | `/executive-hub?tab=agent-ops` | `agent-ops` | `agent_ops_approved` |
| 2 | `agent_ops_approved` | Tenant Ops | `/executive-hub?tab=tenant-ops` | `tenant-ops` | `tenant_ops_approved` + collecting agent assigned |
| 3 | `tenant_ops_approved` | Landlord Ops | `/executive-hub?tab=landlord-ops` | `landlord-ops` | `landlord_ops_approved` + UGX 5,000 bonus |
| 4 | `landlord_ops_approved` | COO | `/coo/dashboard` | role `coo` / key `coo` | `coo_approved` |
| 5 | `coo_approved` | CFO | `/cfo/dashboard` | role `cfo` / key `cfo` | `funded` + agent landlord float |
| 6 | `funded` -> `repaying` -> `completed` | Agent Ops + CFO | agent-ops tab, CFO receivables | `agent-ops` / `cfo` | collection monitoring |

---

## 13. Practical notes for reviewers

1. An executive-hub tab is unreachable without its `staff_permissions` key, even for a person holding the matching job title. A COO who cannot see Landlord Ops needs the `landlord-ops` grant, not a new role.
2. Only two statuses represent real work waiting: `pending` and `coo_approved`. Anything sitting in `agent_ops_approved` or `tenant_ops_approved` for more than a day is an unattended desk.
3. `funded` with no collections is the highest-risk state in the system: company money has left, and there is no evidence the landlord received it.
4. The UGX 5,000 landlord bonus is paid at Landlord Ops approval, not at funding. Approving a fabricated landlord pays an agent immediately, before any COO or CFO review.
5. Every approval stamps a reviewer id, a timestamp and a comment column. A stage with an empty comment is an unauditable approval.