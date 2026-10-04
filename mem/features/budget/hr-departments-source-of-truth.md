---
name: Budget departments = hr_departments only
description: Department budgets must reference an active hr_departments row; membership from HR assignments; per-department route override table
type: constraint
---
Department Budgets use `hr_departments` as the sole source of truth.

- `budget_submissions.department_id` is NOT NULL and FKs `hr_departments`; `budget_save_draft` rejects missing or inactive departments.
- A user's budgeting departments come only from active `hr_assignments` → active `hr_departments` (`budget_user_department_ids`). Free-text `staff_profiles.department` matching was removed.
- Application roles (ceo/coo/cfo/cto/hr) are NEVER departments. Do not create a hard-coded department list for budgeting.
- Routing: `budget_department_route(department_id)` returns a configured override from `budget_department_routes`, else `coo` for keys tenant_ops/agent_ops/landlord_ops/partner_ops, else `direct`.
- Display names throughout the workflow come from `hr_departments.name`; totals always summed live from `budget_submission_lines.line_total`.