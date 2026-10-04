# Plan: Scope-fenced edit to `src/hr/pay/api/myPay.ts`

## Goal
Add an explicit staff-id resolution step to `listMyPayslips()` and scope the existing payslip query by that `staff_id`, while preserving all current filters, return shape, and types.

## Changes (single file only)

File: `src/hr/pay/api/myPay.ts`

1. At the start of `listMyPayslips()`:
   - Query `hr_staff` for the row whose `user_id` matches the current Supabase user.
   - Use `.maybeSingle()` so a missing staff record returns `null` safely.
   - If no `staffRow.id` is found, return `[]` immediately.

2. Append `.eq('staff_id', staffRow.id)` to the existing `hr_pay_payslips` query.

3. Keep unchanged:
   - The existing `.eq('is_current', true)` filter.
   - The existing `.in('hr_pay_runs.status', ['paid', 'locked'])` filter.
   - The full select list and `hr_pay_runs!inner(...)` join.
   - The `unwrap` / cast pattern and `Promise<MyPayslipRow[]>` return type.
   - The employee self-view comment.

## Verification
- Confirm the function still returns `Promise<MyPayslipRow[]>`.
- Confirm no other files are modified.
- Report lines added, lines removed, and the exact `.eq('staff_id', ...)` line.
