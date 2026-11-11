# 266 — Receipt Archive home (Screen 1): money in and money out in one searchable list (2026-11-11)

**Status: `20261105180000_partner_receipts.sql` and `20261111090000_receipt_archive_unified.sql` APPLIED to production by Josh on 2026-11-11 (checked: counter 4299, 0 receipts, both archive RPCs executable by `authenticated` and not `anon`, RLS read policy plus staff-MFA restrictive policy on all tables). `20261111110000_partner_receipts_tighten_grants.sql` was applied by Josh and verified the same day (anon: no access to any of the four tables; authenticated: SELECT only on the three receipt tables, nothing on the counter; archive functions still executable; service_role can still update the counter). Code is on `dev/financial-ops`, NOT PUSHED.**

**Grants finding (2026-11-11):** after applying, production showed `authenticated` holding every table privilege and `anon` holding SELECT on the four receipt tables (project default privileges). RLS still blocks it (no write policies, protect triggers), so nothing was exposed, but the repo rule is grants as the second lock. The tighten-grants migration removes `anon` access entirely, leaves `authenticated` SELECT only on the three receipt tables, and none on the counter. Re-check with `information_schema.role_table_grants` after applying.

**Also fixed in the partner receipts migration before it was applied:** `can_issue_partner_receipt` ignored `staff_permissions.revoked_at` (a revoked Financial Ops grant could still issue receipts); read policies now wrap `auth.uid()` in a select; staff-MFA restrictive policy added on all four tables.

## CTO ask
Replace the paper receipt books with a receipt archive covering money that comes in and money that goes out, searchable by the client's phone number, laid out like the approved mockup (Screen 1 of 6). Digital receipts start at No. 4300 (paper ran to 4299).

## What was found
- `/admin/financial-ops/receipt-archive` already existed as a **payout-only** archive (`ReceiptArchivePanel`: completed `withdrawal_requests` with a `receipt_token`; 12,655 rows in production on 2026-11-11).
- The money-in side is `partner_receipts` (migration `20261105180000_partner_receipts.sql`, panel `PartnerReceiptsPanel` at `?tool=partner_receipts`). **That migration is not applied in production** (checked 2026-11-11: `partner_receipts` and `partner_receipt_counter` do not exist). The counter in it was seeded at 4102, which is out of date.

## Change
- `supabase/migrations/20261111090000_receipt_archive_unified.sql` (+ `.rollback.sql`), read-only:
  - Lifts `partner_receipt_counter.last_no` to at least 4299 (never lowers it), so the first digital receipt is 4300.
  - `receipt_phone_key(text)`: last 9 digits, so `0772123456`, `772123456` and `+256 772 123 456` are one key.
  - `search_receipt_archive(...)`: unions partner receipts (IN) with completed payout receipts (OUT); filters on search, direction, source, method, status, dates; server-side paging with a total count. Search matches phone (any format, or the last digits when 6+ digits or typed with a leading 0/+), receipt number, amount, or name. Payouts are only returned to people who can issue (Financial Ops, CFO, super admin); Partner Ops see money in only.
  - `receipt_archive_summary(from, to)`: receipts issued, money in, money out, voided, pending (open corrections plus unconfirmed cash receipts).
  - Both are `SECURITY DEFINER`, check the caller themselves, and are granted to `authenticated` only (functions are closed by default).
- `src/hooks/useReceiptArchive.ts`: the two RPCs plus the date-range presets. A search ignores the date range (finds the client across all dates); the summary cards still follow the range.
- `src/components/financial-ops/ReceiptArchiveHome.tsx`: header, five summary cards (also quick filters), In/Out toggle, search, date presets, method/source/status filters, table, paging, Excel export. Filters live in the URL. A second tab, "Payout proofs", keeps the old `ReceiptArchivePanel` (proof of payment, funding source) untouched.
- `FinancialOpsCommandCenter.tsx`: the `receipt_archive` tool now renders `ReceiptArchiveHome`.

## Screen 2 (2026-11-11): client card for a phone-number search
No new migration. `useClientCard` (in `useReceiptArchive.ts`) calls the existing `search_receipt_archive` with the typed number only (no date range, direction or status filters, up to 200 rows), keeps the rows whose last 9 digits contain what was typed, and shows one card above the table: name, formatted phone, receipt count, total in, total out (issued receipts only; voided and corrected are not money that moved), first receipt date. More than one distinct name on the number shows an amber "names used on this number" flag (a prompt to review, not an accusation). If several different numbers match a partial entry, it asks for the full number instead of guessing one client. Over 200 receipts on a number shows "200+" and says totals cover the 200 most recent. Partner Ops see no payouts, so their total out is always 0. The sums are display-only arithmetic on already-issued receipts.

## Rules kept
Read-only: nothing writes to wallets or `general_ledger`. Copy uses "Returns payout", not ROI.

## Verified
`npm run guard:all` passes. eslint clean on the new files. **Not** run: `tsc` (runs out of memory locally), the SQL against a database, or the page in a browser.

## Not done / open
- **Apply order:** `20261105180000_partner_receipts.sql` first, then `20261111090000_receipt_archive_unified.sql`. After applying, check `has_function_privilege('authenticated','public.search_receipt_archive(text,text,date,date,text,text,text,integer,integer)','EXECUTE')` and open the page as Financial Ops and as Partner Ops.
- Row actions are PDF download (money in, the existing coloured PDF) and open/copy link (money out). View drawer, black-and-white receipt copy, issue drawer, corrections and daily close are Screens 2 to 6 and are not built.
- Phone is optional on partner receipts today, so receipts without one cannot be found by phone. Making it required belongs to the issue screen.
- Rent collection receipts are not in the archive yet; the Source filter lists partner receipts and payouts only.
- Mobile shows the table with horizontal scroll; the stacked-card layout is not built.
