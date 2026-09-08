---
name: Agent advance activity gate
description: Zero-activity agents cannot request an advance; at least one field-work signal required (sub-agent, rent request, collection, promissory note, verified house)
type: feature
---
An agent may only submit an `agent_advance_requests` row if they have at least ONE
recorded piece of field work. Signals (any one is enough):

- recruited sub-agent (`agent_subagents`, status active/verified or accepted_at set)
- rent request raised for a tenant (`rent_requests.agent_id`, tenant_id set, agent <> tenant)
- rent collected (`agent_collections`)
- activated/approved promissory note (`promissory_notes`)
- house they listed that got verified (`house_listings.verified_at` not null, status <> rejected)

Enforcement:
- `public.agent_advance_activity(uuid)` → jsonb snapshot with per-signal counts, `signals`, `eligible`.
- Trigger `zz_enforce_agent_advance_activity` (BEFORE INSERT on `agent_advance_requests`) raises `ADVANCE_NO_ACTIVITY: ...`.
- UI: `useAgentAdvanceActivity` + `AdvanceActivityGateCard` replace the "Request a new advance" button with an unlock checklist.

Limit structure (agents, `recalculate_credit_limit`): base UGX 20,000; sub-agents
(+30,000 active / +9,000 registered, cap 3M); rent collected 6% of lifetime (cap 2.4M);
rent requests +9,000 each (cap 1.5M); activated promissory notes +9,000 each (cap 600K);
hard cap UGX 9,000,000. House-listing, ratings, receipts and landlord-rent bonuses are
retired for agents.

## CFO override (2026-09-08)

Business decision: the CFO must be able to issue an advance regardless of any
eligibility condition. The gate above still applies to agent self-requests and the
ops-approval pipeline; it is stood down only for a request explicitly stamped as an
override.

- `agent_advance_requests.gate_override` (+ `_by`, `_at`, `_reason`, `_gates`) carries it.
- `aaa_guard_advance_gate_override` fires first and rejects the flag unless the caller
  holds cfo/ceo/super_admin/admin, and unless a reason is supplied. It cannot be
  self-granted from the client.
- All seven issuance gates early-return on the flag: min principal (request + advance
  row), no-double-advance, tiered rate rewrite, activity, duplicate account, and the
  UGX 1,000 / 33% bounds in `enforce_advance_principal_integrity`. Two rules are
  deliberately NOT overridable: principal must be > 0, and an existing advance's
  principal can never be increased on UPDATE.
- `disburse_agent_advance_request` relaxes its own UGX 10,000 / 33% checks for an
  overridden request and copies the flag onto `agent_advances`.
- Entry point is `cfo_create_advance(...)` — authorises, snapshots the gates it is
  bypassing into `gate_override_gates`, and writes `audit_logs.action_type =
  'cfo_advance_gate_override'`. The CFO dialog no longer inserts the row directly.
- `agent_advance_blocking_gates(agent, principal, rate)` previews the same gates so the
  operator sees them before filling the form.
- Review overrides with `SELECT * FROM v_advance_gate_overrides`.
