# People & Access audit register

Rebuild the HR audit screen as a read-only register of people and access events.

## What the user sees

A single table of the last 90 days of people/access actions (max 100 most recent rows), with columns:

```text
When | Who acted | Action | Target | Surface
```

- "When" shows a short date and time.
- "Action" is the raw action code turned into readable words (e.g. `permission_revoked` -> "Permission revoked").
- "Who acted" is the acting account; "Target" is the affected record; "Surface" is the area of the app the action touched.
- Any missing value renders an em dash, never a blank cell.
- Clicking a row expands it to show the remaining details as plain key/value lines. No buttons, no links, no editing.
- Below the table, one muted line: "Application actions only. Database schema changes are not recorded here."

## Scope

Exactly one file is edited: `src/components/hr/HRAudit.tsx`. No new files, routes, sidebar items or exports. No writes of any kind — the query is a single read.

## Technical details

- Module-level constant `AUDIT_ACTION_TYPES` holds the 20 action codes listed in the request.
- Query: `audit_logs` select of `id, created_at, user_id, action_type, table_name, record_id, metadata`, with `.in('action_type', AUDIT_ACTION_TYPES)`, `.gte('created_at', <now - 90 days ISO>)`, `.order('created_at', { ascending: false })`, `.limit(100)`. Both the action filter and the 90-day bound are always applied.
- Expansion state is a local `Set<string>` of row ids; expanded content renders `metadata` entries plus any column not already shown as a table cell.
- Rendered with the existing shadcn `Table` primitives; loading and empty states use muted text.
- Verified against the live data: 382 rows match these action codes within the last 90 days, so the first load returns the capped 100 rows.
