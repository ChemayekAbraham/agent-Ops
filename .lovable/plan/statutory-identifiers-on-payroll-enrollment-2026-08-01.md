# Statutory identifiers on payroll enrollment

TIN, NSSF number and LST district are filing identity data. They exist in a table that is currently empty and there is no screen to capture them. This adds capture and a completeness signal without touching any payroll figure.

## What changes

Exactly two files: `src/hr/pay/api/enrollment.ts` and `src/hr/pay/PayrollEnrollment.tsx`.

### Data layer (`enrollment.ts`)
- `listEnrollment` gains one extra parallel read of `hr_pay_statutory_ids` (`staff_id, tin, nssf_number, lst_district`) for the same staff ids, mapped per person.
- `EnrollmentRow` gains `tin`, `nssfNumber`, `lstDistrict` — each `string | null`, null when the person has no row.
- New export `setStatutoryIds(staffId, tin, nssf, lstDistrict)` calling `supabase.rpc('hr_pay_set_statutory_ids', { _staff_id, _tin, _nssf, _lst_district })`, throwing the error message verbatim. The table is never written directly, matching the existing `setStatutoryProfile` pattern.

### Screen (`PayrollEnrollment.tsx`)
- New column headed "Statutory IDs", placed immediately after the Basis column. The cell shows three small labelled indicators in a row — TIN, NSSF, LST — each a tick when the value is present and a dash in muted red when missing. The values themselves are never rendered in the table, so the printed sheet carries only ticks and dashes.
- The cell is clickable and opens a dialog headed "Statutory identifiers" with the line: "These appear on filed URA and NSSF returns. They do not affect any payroll figure."
- Dialog fields: TIN, NSSF number, LST district. All three optional, pre-filled from current values. Saving calls `setStatutoryIds`, then reloads the table through the existing load function.
- Alongside the existing counts, a new "Statutory IDs complete: N of M" figure, where complete means all three values present. Rendered amber when N is less than M.

## Notes
- No writes to `hr_pay_compensation`, `hr_pay_runs` or `hr_pay_payslips` are added; existing basic-pay and statutory-profile actions on the screen stay as they are.
- No new files, no packages, nothing under `supabase/functions/` or `src/hr/pay/calculator/`.
- Current state: the identifiers table holds 0 rows against 26 active staff, so the new count will open at "0 of 26" in amber.
