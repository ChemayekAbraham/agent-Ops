# HR People & Access Audit — filters and figures

Single file: `src/components/hr/HRAudit.tsx`. Read-only, no writes, allowlist and table columns unchanged.

## What gets added

**Figures line** (top, compact inline numbers with small labels, matching the Staff Directory style — no cards, no boxes, not clickable). Always scoped to the last 30 days regardless of the date-range select:

- Role changes
- Grant changes
- Password events
- Account removals

Each is its own count-only query (`head: true`, `count: 'exact'`) filtered to that group's action types and the 30-day window. No rows are ever fetched to compute a count.

**Command row** (single line, below the figures, above the table):

- Date range select: Last 30 days / Last 90 days (default) / Last 12 months
- Action group select: All (existing full allowlist) / Roles / Grants / Passwords / Accounts
- Free-text search on the acting user

Date range and action group are applied in the Supabase query (row cap stays 100). The search filters already-loaded rows client-side.

## Group mappings

- Roles: staff_role_enabled, staff_role_disabled, role_assigned, role_disabled, role_removed, forced_default_role_set
- Grants: permission_granted, permission_revoked
- Passwords: staff_password_reset, staff_password_provisioned, staff_password_changed, staff_password_revert, cto_temp_password_issued, forced_password_reset_completed
- Accounts: delete_account, archive_account, admin_user_deletion, account_deletion

## Technical notes

- `sinceIso` becomes a function of the selected range; the 90-day bound stays the default.
- Query key includes range and group so switching refetches.
- Row expansion, column order (When · Who acted · Action · Target · Surface) and the muted caveat line are untouched.
- Empty-state copy is generalised to reflect the selected window.

## Expected figures (verified now against audit_logs, last 30 days)

Role changes 96 · Grant changes 148 · Password events 1 · Account removals 40.
Default 90-day All selection matches 382 rows; the table renders the 100 most recent.
