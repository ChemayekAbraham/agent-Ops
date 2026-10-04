# Fix "malformed array literal: rent_amount" on tenant rent / balance edits

## What is happening

Tenant Operations already has the editing UI (search a tenant → "Edit balance / rent" → set rent amount, outstanding balance, reason). The save path calls the `ops_edit_tenant_balance` routine, which updates the rent record correctly.

The failure comes from an audit trigger that fires on that update (`log_rent_amount_change`). It builds the list of changed field names by appending bare quoted words to a text-array variable. Postgres resolves each of those untyped words as an array literal instead of a single text value, so the first append — `rent_amount` — aborts the whole transaction with:

```text
malformed array literal: rent_amount
```

Confirmed by reading the live function body: the appends are untyped (`fields := fields || 'rent_amount'`), and `rent_amount_change_log.changed_fields` is an array column. Any rent-amount edit from anywhere in the app hits this, not just Tenant Ops.

## Fix

One database migration that recreates `log_rent_amount_change` with each appended field name explicitly typed as text (e.g. `|| 'rent_amount'::text`). No other logic in the trigger changes: same audit row, same system event, same fields tracked.

## Access

`ops_edit_tenant_balance` is gated by `is_tenant_ops_staff`, whose allowlist is manager, operations, coo, super_admin, ceo, cfo, cto, cmo, crm, employee, hr. The `admin` and `tenant_ops` roles are not in that list. Since the request says "allow the admin to edit", the same migration adds `admin` and `tenant_ops` to that allowlist so admin-role accounts can use the panel.

## Verification

- Re-run a rent-amount edit on a real rent record: it saves, derived fees and daily repayment recalculate, and a change-log row lands with the correct changed-field names.
- Outstanding-balance-only edit (no rent change) still saves.
- Edit history list and its CSV/PDF export still render.

## No frontend changes

`TenantBalanceEditPanel.tsx` is already correct; nothing in the UI needs editing.