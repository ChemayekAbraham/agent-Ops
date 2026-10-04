---
name: Free Service Center qualification
description: Permanent agent milestone — 20 qualifying sub-agents (each with >=1 active tenant) + 5 personal active tenants unlocks a free Welile Service Center request
type: feature
---
Permanent (NOT weekly campaign) milestone replacing the weekly sub-agent invite banner on the agent dashboard home.

Rules (rule_version `service_center_qualification_v1`, stored in `service_center_qualification_config`):
- qualifying_sub_agents >= 20 — a sub-agent counts only when `agent_subagents.status='verified'`, not frozen, and THAT sub-agent independently has >= 1 active tenant.
- main_agent_active_tenants >= 5 — distinct tenants on the agent's own (agent_id or assigned_agent_id) rent requests.
- Active tenant = `rent_requests.status IN ('funded','repaying')` AND `tenancy_status='active'`, tenant profile not frozen. Distinct tenant_id only.
- progress = ((min(subs/20,1) + min(personal/5,1)) / 2) * 100 — both requirements must independently pass for `is_qualified`.

Server-authoritative only: `get_service_center_qualification(p_agent_id)` returns every count/flag; the frontend never derives eligibility.
Submit via `submit_service_center_request(...)` (re-checks qualification, one open request per agent via partial unique index, writes snapshot + `service_center_qualifications` first-qualified row).
Admin: `admin_list_service_center_requests`, `admin_decide_service_center_request` (approve/reject/more_info/note; rejection reason mandatory). Every status change audited in `service_center_request_events`.
UI: `ServiceCenterQualificationCard` (agent home) + `ServiceCenterRequestDialog`; Agent Ops → Service Centers → "Free Center Requests" (`ServiceCenterRequestsQueue`).
