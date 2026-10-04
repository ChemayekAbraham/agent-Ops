---
name: Budget cycle open notifications (department-level)
description: Opening a budget cycle creates ONE notice per targeted hr_departments row (budget_department_notifications) PLUS a per-user notice for each designated department head (budget_cycle_notifications); since 2026-09-09 visibility is head-gated, not dashboard-wide
type: feature
---
When a `budget_calls` row becomes `status='open'`, `budget_notify_cycle_open(call_id)` inserts **one row per active `hr_departments` row** into `budget_department_notifications` (UNIQUE `call_id, department_id`) — no per-user fan-out.

- Visibility authority = **department dashboard access** (`operations_departments.department = hr_departments.key`), via `budget_can_access_department(dept_id, user_id)`. HR assignments are NOT used for notification recipients.
- Read state per user: `budget_department_notification_reads` (`notification_id, user_id`).
- Client: `get_budget_department_notifications()` (cycle title, department name, deadline, message, link `/budgets`, `is_read`) and `mark_budget_department_notification_read(_notification_id)`.
- UI: `BudgetDepartmentNotificationBell` in the Executive Hub header and the Partner Ops top bar; clicking a notice marks it read for that user and navigates to `/budgets`.
- Reopening a cycle never duplicates (ON CONFLICT DO NOTHING on `call_id, department_id`).
- Legacy per-user table `budget_cycle_notifications` remains but is no longer written by cycle-open.
- `budget_user_department_ids` still unions HR assignments and dashboard access (submission rights).
- Routing untouched: tenant_ops/agent_ops/landlord_ops/partner_ops → `pending_coo`; others → `submitted` (direct to CFO). Post-submission `budget_notify` in-app notices unchanged (`type='budget'` allowlisted past `block_all_notification_inserts`).

**2026-08-19 visibility fix**: `budget_can_access_department` now ALSO accepts active `staff_permissions.permitted_dashboard` grants (tenant-ops/agent-ops/landlord-ops/partner-ops → matching dept; cfo|financial-ops→finance; cmo→marketing; cto→engineering + product R&D; coo|company-ops→operations; ceo|director→board_of_directors; hr→interns + support_and_welfare; crm→partnership), not just `operations_departments`. The bell no longer self-hides when empty — it renders in every department dashboard header with a "No budget notices" empty state.

**2026-09-09 head-only routing (supersedes parts of the above).** Cycle-open notification
is no longer dashboard-wide. Two bullets above are now stale: visibility is head-gated,
and `budget_cycle_notifications` IS written again.

- New table `budget_department_heads` (department_id, user_id, active, is_primary, note)
  is the designated-head mapping; `hr_departments` has no head column and the legacy
  `departments.head_user_id` is unused by budgets (1 row).
- `budget_notify_cycle_open` still writes the department-level audit row, and now ALSO
  inserts one row per active designated head into `budget_cycle_notifications`
  (UNIQUE `call_id, department_id, user_id`) plus a personal `budget_notify`. The
  personal notify fires only when that insert actually inserted, because the function
  runs twice per cycle (explicit call in `budget_create_cycle` AND the
  `trg_budget_notify_cycle_open` trigger) and `notifications` has no idempotency key.
- `get_budget_department_notifications` and the table's RLS policy are head-gated:
  a department with designated heads is visible only to those heads plus
  `is_budget_reviewer`. A department with NO designated head falls back to the previous
  dashboard-access behaviour, so notices never go dark.
- Not seeded: Human Resource Management and Support & Security have no matching
  `hr_departments` row, so Mark and Rogers are undesignated and those two departments
  still use the fallback.
- First-level approval identity also changed: `budget_department_routes.reviewer_department_id`
  points the four subordinate ops departments at Operations, and
  `budget_can_first_level_review` / `budget_may_first_level_act` resolve the approver
  through `budget_department_heads`. Previously any of nine `coo`/`super_admin` holders
  could approve; now only the Head of Operations. Self-approval is blocked in all eight
  approval functions. Routing itself is unchanged (four → `pending_coo`, Operations → direct).
- `budget_my_submissions` no longer filters on `budget_home_department_id` (which returns
  one department and prefers the primary HR assignment); it now uses
  `budget_user_department_ids`, matching filing rights. Four heads are HR-assigned to
  `operations` while heading an ops department, so their own drafts had been invisible
  to them.

See [[submission-gate]] for the mandatory full-screen prompt built on top of this.
