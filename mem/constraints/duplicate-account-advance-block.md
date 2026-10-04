---
name: Duplicate-account advance block
description: Duplicate accounts (same full name) cannot request agent advances; staff flag them via reject_advance_as_duplicate, manager-only release
type: constraint
---
- `agent_duplicate_flags` (one active row per agent, unique partial index) is the register of accounts marked as duplicates.
- Trigger `zz_enforce_no_duplicate_account_advance` on `agent_advance_requests` raises `DUPLICATE_ACCOUNT_BLOCKED` when:
  - the agent has an active duplicate flag, or
  - another profile with the same normalized full name (letters only, ≥6 chars) already has an ongoing advance (`active`/`overdue`, outstanding > 0) or a request in the approval pipeline.
- `reject_advance_as_duplicate(request_id, reason, duplicate_of_user_id, match_type)` — CFO / Agent Ops / COO / operations / manager; rejects the request AND flags the account in one step. Reason ≥10 chars, audit-logged.
- `release_agent_duplicate_flag(agent_id, reason)` — manager / super_admin only.
- UI: `RejectAsDuplicateDialog` + `useAgentDuplicateFlags` (src/components/ops/RejectAsDuplicateDialog.tsx); aggravated red styling in `DuplicateAccountAlert` when a duplicate already borrows.