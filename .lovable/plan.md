# Welile Schools fees plans: build plan

## Where the button is today
- **Agent menu drawer** (`src/components/agent/AgentMenuDrawer.tsx`, lines 200 and 228): "Welile Schools — Register everyone at the school gate", opens `/agent/welile-schools`.
- **Dashboard header dropdown** (`src/components/DashboardHeader.tsx` ~line 520): same link.
- **Route** (`src/App.tsx` line 967): `AgentWelileSchools` page, allowed for agent, super_admin, manager, operations, ceo, coo, cto.
- **What it does now:** a school gate registration tool. The agent picks or creates a school (`welile_schools`, with GPS and location), then logs gate visits (`welile_school_gate_logs`) and registers students, staff and facilities (`welile_school_profiles`) through the six-step "Welile Schools Bot" chat or the Classic Form. It works offline and retries saves. Agent Ops sees everything in `WelileSchoolsOps`. Nothing about fees, payments or commission exists yet.

## Where the new screens go
- `/agent/welile-schools` becomes a hub with bottom tabs: **My Schools**, **Enrol**, **Fees Plans**, **Follow-ups**, **Commission**, plus the existing **Gate Registration** tool as its own tab (not rewritten).
- Sub-routes: `/agent/welile-schools/plans/:id` (plan detail) and `/agent/welile-schools/enrol`. The existing route guard stays the same.
- Menu wording changes to "Fees plans, schools and gate registration". The link itself doesn't change.
- A staff review queue tab is added to the existing `WelileSchoolsOps` in Agent Ops: approve enrolments, record payments to schools, manage school terms and the facilitation rate.

## Database (new tables, all named `welile_school_*`)
- **Reuse `welile_schools`** as the partner school record. New table `welile_school_partners`: school_id, assigned_agent_id, partner status, payout details for the school, active from/to. One active assignment per school (partial unique index).
- **`welile_school_terms`**: school_id, year, term label, start/end dates. The clearing deadline (end date minus 14 days) is computed in the database.
- **`welile_school_students`**: school_id, student name, class/level, parent name, phone, National ID, guardian name/phone, optional link to an existing `welile_school_profiles` row.
- **`welile_school_fees_plans`**: student_id, term_id, fees amount, facilitation rate (copied from the setting at approval), facilitation fee, total, start date, deadline, daily amount, invoice file path, status (`pending_review`, `returned`, `approved`, `school_paid`, `active`, `cleared`, `cleared_late`, `cancelled`), reviewer and timestamps. A partial unique index enforces one open plan per student. A trigger blocks opening a new plan until the previous one is cleared.
- **`welile_school_fee_payments`**: plan_id, amount, mobile money channel, provider reference (unique), paid_at, recorded_by, client_ref. Append-only: no update or delete.
- **`welile_school_payments_to_school`**: plan_id, amount, reference, paid_by, paid_at. Append-only, staff only.
- **`welile_school_commission`**: plan_id, agent_id, amount, state (`pending`, `earned`, `not_earned`, `paid`). Written only by the database when a plan clears.
- **`welile_school_settings`**: one row (facilitation rate, commission rule), editable only by admins through a function that also writes `audit_logs`.
- **Invoice uploads:** a private storage bucket `welile-school-invoices`, with each file in a folder named after the uploading agent's user id.

### Who can see what (RLS)
- Agents read only schools where they are the active assigned agent (helper `welile_school_is_my_school(school_id)`), and students, plans, payments and commission linked to those schools. Agents can create students and `pending_review` plans only for their own schools, and can never change status, amounts after submission, or payments.
- Staff (`welile_schools_ops_ok()`) see everything and approve. Approval, status changes, payments and commission go only through SECURITY DEFINER functions.
- Every table: explicit grants, row-level security on, the staff-MFA restrictive policy, `(select auth.uid())` wrapping, no delete policy. Each new function gets an `execute` grant to `authenticated` and checks the caller itself.

### Figures decided only by the database
- `welile_school_plan_summary(plan_id)` / `welile_school_my_plans(...)` return balance, paid, days left, daily amount, weekly target, expected-to-date and status. The status rule: On track if paid is at or above expected to date; Behind if no more than 7 days of daily amount behind; At risk if more than 7 days behind, or the remaining balance divided by days left is more than the daily amount by a set margin. The agent screens only display these.
- `welile_school_preview_plan(school_id, term_id, fees)` gives the pre-submit daily amount, weekly target and deadline, using the same math so preview and approval cannot disagree.
- `welile_school_follow_ups()` returns today's Behind and At risk parents for the calling agent. `welile_school_my_commission()` returns earned and pending commission.
- The small rounding helpers live in `src/lib/welileSchoolFees.ts` for display only, with tests that match the database.

## Reusing existing patterns
- **Layout:** `AgentWelileSchools` header style, existing cards, badges and bottom sheets, `formatUGX`, the Uganda location picker, and the offline `client_ref` queue (reused for enrolment drafts).
- **Calls and WhatsApp:** the same `tel:` / `wa.me` pattern used by CRM and agent follow-up screens.
- **Money movement:** parents' mobile money payments and Welile's payment to the school must post through the ledger (`create_ledger_transaction`, `apply_wallet_movement`) with new CFO-approved categories. Until those categories are approved, phases 1–3 only **record** payments (the same approach as v360 and Welile Medicine receipts) and move no wallet or ledger money.
- **Commission:** recorded in `welile_school_commission` and paid later through the existing agent commission payout path once the CFO approves the category. It never goes straight into a wallet.
- **Events:** every state change emits a `system_events` row, and enrolment and payments call `capture_trust_signal` (TRUST MISSION and AGENT FIELD MANDATE).

## Phased build order
1. **Foundation:** tables, grants, RLS, settings, terms, partner assignment, staff screens to assign agents and enter term dates. Agent "My Schools" tab.
2. **Enrol:** preview function, enrolment form with invoice upload, pending review, staff approve/return queue, "school paid" recording.
3. **Fees Plans and Follow-ups:** plan list with filters, detail view with payment history, staff payment recording (manual entry with provider reference), Follow-ups tab.
4. **Commission:** earned/not-earned decided when a plan clears, "My Commission" tab.
5. **Money (needs CFO approval):** ledger categories, automatic mobile money payment matching, actual payment to schools and commission payout.

Each phase ships with database tests in `supabase/tests/` and Vitest tests for the daily amount, weekly target, status bands and the one-open-plan rule.

## Conflicts and decisions for you
- **Terminology clash:** project rules require "Returns" / "Rent profit share" wording for partners, and the Rent Plan engine is used throughout. The new section follows your banned-word list. Some existing shared helpers and ledger categories use words like `advance`, `debt` or `interest` (for example `advance_balance`, `interest_expense`). I won't reuse those names in this section, but the ledger posting in phase 5 may have to touch existing categories.
- **Who sees which schools today:** `welile_schools` is currently readable by every Welile Schools agent (`ws_select`), and schools have no assigned agent. Plan: keep that read for the gate tool, and scope the new fees data through `welile_school_partners`. Tell me if agents should also stop seeing other agents' schools in the gate tool.
- **"Agents never collect cash"** but phase 3 relies on staff typing in mobile money references until automatic matching exists (phase 5). Agents can't record payments.
- **Commission amount:** you didn't give a rate. It will be stored as an admin setting, empty until set.
- **"Cannot clear at current pace":** I need a definition of "current pace". Proposed: the average daily payment over the last 14 days compared with the remaining balance per remaining day.
- **Production database:** this project uses a shared production database, and migration files don't always match it. Every migration is checked against the live schema first, and nothing is applied without your go-ahead.
