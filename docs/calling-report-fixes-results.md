# Calling & Pipeline Report Fixes — Real-Data Verification Results

**Date verified:** 4 November 2026 (Africa/Kampala)  
**Branch:** `dev/calling-report-fixes`  
**Database migration:** `supabase/migrations/20261104110000_staff_calling_report_true_calls_and_test_contacts.sql` (applied and verified live; recorded in `supabase_migrations.schema_migrations` as `20261104110000`)  
**Period tested:** Full Wednesday–Tuesday Kampala week **28 Oct 2026 – 3 Nov 2026** (`2026-10-28T00:00:00+03:00` to `2026-11-04T00:00:00+03:00`)

---

## 1. Real Before / After Figures (`2026-10-28` to `2026-11-03`, Wed–Tue)

All figures below were queried directly from the live production database (`public.staff_calling_detailed_report('2026-10-28 00:00:00+03'::timestamptz, '2026-11-04 00:00:00+03'::timestamptz)`) before and after applying migration `20261104110000_staff_calling_report_true_calls_and_test_contacts.sql`.

### A. Per-Officer Summary (`28 Oct 2026 – 3 Nov 2026`)

| Staff Member | Metric | Before Fix | After Fix | What Changed & Why |
| --- | --- | --- | --- | --- |
| **Hanisha** (`Hanishah Amber Kawuki`, `fda0d518-98c4-45e4-83d8-64266b25eefa`) | Headline Call Count | `245` total entries (`245` dialed) | **`Calls made: 252 (245 recorded, 7 awaiting a result)`** | All 7 timestamped Calling Center dials without a saved outcome (`6` older than 24h previously dropped into `excluded_reveals` + `1` within 24h on 3 Nov for `Annet Namula` previously hidden completely) are now included in `Calls made`. |
| **Hanisha** | Reached / Not reached / Awaiting result | `70` reached / `175` not reached | `70` reached (`28.6%`) / `175` not reached / `7` awaiting result | Reach rate (`70 / 245 = 28.6%`) continues to use recorded calls as its denominator so unrecorded dials do not artificially depress reach rate. |
| **Hanisha** | Cross-system merged dupes (`<= 3 min`) | Hidden inside 15-min same-source/cross-source collapse | `0` merged | No cross-system duplicates for Hanisha in this week. |
| **Hanisha** | Section 5 `"Phone off"` / `"Wrong number"` rows | `0` / `0` (not in Section 5) | **`Phone off: 62`** / **`Wrong number: 57`** | Previously only appeared in Section 3A outcome bars; now appear as their own category rows in Section 5 (and Section 3B / Section 4). |
| **Winnie** (`Winfred Asiimwe`, `a9258d45-3e27-4827-af71-64344e76fb4f`) | Headline Call Count | `300` total entries (`300` dialed) | **`Calls made: 303 (300 recorded, 3 awaiting a result)`** | All 3 unrecorded dials (`2` in Calling Center + `1` in Landlord Ops Calling Hub) are now included in `Calls made` as `"Awaiting result"`. |
| **Winnie** | Reached / Not reached / Awaiting result | `105` reached / `195` not reached | `105` reached (`35.0%`) / `195` not reached / `3` awaiting result | All 300 recorded outcomes + 3 awaiting-result dials are visible on the headline and in the chronological log. |
| **Winnie** | Cross-system merged dupes (`<= 3 min`) | Hidden inside 15-min collapse | `0` merged | No cross-system duplicates for Winnie in this week. |
| **Winnie** | Section 5 `"Phone off"` / `"Wrong number"` rows | `0` / `0` (not in Section 5) | **`Wrong number: 76`** / **`Phone off: 60`** | Both categories now appear in Section 5 with officer notes. |
| **Jane** (`Janehephzibar Gimono`, `5295252d-f477-42a9-92f5-af56e503e33d`) | Headline Call Count | `104` total entries (`100` dialed + `4` pipeline reviews) | **`Calls made: 100 (100 recorded, 0 awaiting a result)`** (`+ 4 pipeline reviews = 104 entries`) | Every call Jane made had a saved outcome (`95` reached, `5` not reached), plus `4` Landlord Ops verification reviews where no separate awareness call was logged within 3 minutes. |
| **Jane** | Cross-system merged dupes (`<= 3 min`) | Silently collapsed across 15 min without explanation | **`88` cross-system duplicate logs merged** (shown in plain English near the headline) | When Jane logs a Landlord Awareness Call (`landlord_calls`) and clicks Verify on the same Rent Plan (`rent_requests.landlord_ops_reviewed_by`) within 3 minutes, the two systems write two rows for the same physical call. The report merges them into 1 call while preserving both notes, and explains the `88` merged cross-system logs right below the headline. |
| **Jane** | Section 5 `"Phone off"` / `"Wrong number"` rows | `0` / `0` (not in Section 5) | **`Phone off: 4`** / **`Wrong number: 1`** | Includes Jane's officer notes (`"Declined: Landlord's number doesn't exist"`, `"Number off"`, `"Phone is off"`). |
| **Team Total** (`Jane + Winnie + Hanisha`) | Headline Call Count | `649` entries (`645` dialed + `4` reviews; `10` unrecorded dials hidden/excluded) | **`Calls made: 655 (645 recorded, 10 awaiting a result)`** (`+ 4 pipeline reviews = 659 entries`) | Every timestamped dial in the period (`655` calls made across `643` distinct phone numbers) is now accounted for in the headline total. |
| **Team Total** | Section 5 `"Wrong number"` / `"Phone off"` rows | `0` / `0` | **`Wrong number: 134`** (`Winnie: 76, Hanisha: 57, Jane: 1`) / **`Phone off: 126`** (`Hanisha: 62, Winnie: 60, Jane: 4`) | Ranked directly in Section 5 alongside written feedback themes. |

---

## 2. Verification of the Three Fixes

### Fix (1): Report Figures vs. Calls Made, 3-Minute Cross-System Dedupe, and `is_test_contact`
1. **Headline `"Calls made: N (M recorded, K awaiting a result)"` split**:
   - `public.staff_calling_detailed_report(p_from, p_to)` now includes every timestamped dial in `cc_call_attempts` (when `outcome IS NULL`, emitted with `outcome = 'awaiting_result'`) and `landlord_call_dials` (when `call_id IS NULL`, emitted with `outcome = 'awaiting_result'`).
   - Both the individual workspace (`IndividualStaffReportPanel`), the team workspace (`GeneralTeamReportPanel`), and both PDF exports (`generateIndividualStaffCallingPdfBlob` and `generateGeneralTeamCallingPdfBlob`) display `"Calls made: N (M recorded, K awaiting a result)"` at the top of the report.
2. **Cross-system-only 3-minute deduplication**:
   - Deduplication in `staff_calling_detailed_report` was narrowed from `900` seconds (15 minutes) across any source to **`180` seconds (3 minutes) strictly across different logging systems (`h.r_source <> m.r_source`)** when at least one row is a pipeline review or awareness call for the same person.
   - Two recorded calls placed minutes apart in the same system (for example, redialing a tenant or landlord in the Calling Center 2 minutes later) are **never** merged.
3. **`is_test_contact` column replaces name-based `\mtest\M` filter**:
   - Added `is_test_contact boolean NOT NULL DEFAULT false` on `public.profiles`, `public.landlords`, and `public.landlord_leads`.
   - Backfilled known internal test records (`System Test Tenant`, `Test Customer`, `test landlord`, `0700000000`) to `is_test_contact = true` while ensuring real people whose names contain `"Testimony"` (`0` false positives) remain `is_test_contact = false`.
   - Removed `x.r_name !~* '\mtest\M'` from `staff_calling_detailed_report`.
4. **Plain-English explanation near the headline**:
   - Replaced the small bottom `"Excluded: N..."` footnote with a clear explanation card right under the `"Calls made"` headline banner whenever any dials are awaiting a result, any 3-minute cross-system duplicate logs were merged, or any `is_test_contact = true` rows were excluded.

### Fix (2): Custom Days Calendar Picker & Exact Week/Month Parity
- Added a third period mode, **`Custom days`** (`mode: 'custom'`), in `src/hooks/useStaffCallingReport.ts` (`buildCustomDaysPeriodWindow(startYmd, endYmd)`) and `src/components/me/StaffCallingReportWorkspace.tsx`, defaulting to the last 7 Kampala days (`addUtcDays(todayYmd, -6)` to `todayYmd`).
- Includes a calendar range popover (`Calendar` with `mode="range"`), quick presets (`Last 7 days`, `Yesterday & Today`), and direct `From` / `To` date inputs with 44 px minimum tap targets on 360 px mobile screens.
- **Live RPC parity check**:
  - `buildWeekPeriodWindow('2026-10-28')` and `buildCustomDaysPeriodWindow('2026-10-28', '2026-11-03')` pass the exact same `p_from = '2026-10-28T00:00:00+03:00'` and `p_to = '2026-11-04T00:00:00+03:00'` to `staff_calling_detailed_report`, returning the exact same `659` rows (`655` calls made + `4` pipeline reviews).
  - `buildMonthPeriodWindow('2026-10', '2026-11-04')` and `buildCustomDaysPeriodWindow('2026-10-01', '2026-10-31')` pass the exact same `p_from = '2026-10-01T00:00:00+03:00'` and `p_to = '2026-11-01T00:00:00+03:00'` to `staff_calling_detailed_report`.
- Both PDF exports label a custom range as `Custom days: DD Mon YYYY - DD Mon YYYY (N days, Africa/Kampala)` and use `CUSTOM RANGE` in the metadata table instead of `Week of...` or a month name.

### Fix (3): `"Wrong number"` and `"Phone off"` as Feedback Categories in Section 5
- `rowFeedbackThemes()` in `src/hooks/useStaffCallingReport.ts` maps `outcome === 'wrong_number'` to **`"Wrong number"`** and `outcome === 'phone_off'` to **`"Phone off"`** as first-class category rows in `themes` (Section 5 of the Team Report, Section 3B of the Individual Report, and Section 6 of the Team PDF), while preserving Section 3A (the outcomes chart) unchanged.
- Officer notes left on `"Wrong number"` or `"Phone off"` calls (such as corrected phone numbers or `"Declined: Landlord's number doesn't exist"`) are attached in `sampleNotes` and displayed directly beneath the category label in the UI and in the PDF table.

---

## 3. Automated Test & Guard Verification

- **Live SQL regression test (`supabase/tests/staff_calling_report_fixes.sql`)**:
  - Verified against the live database inside a rolled-back transaction (`passed_count = 6, total_count = 6, failing = none`):
    1. `is_test_contact` column exists (`boolean NOT NULL DEFAULT false`) on `profiles`, `landlords`, and `landlord_leads`.
    2. Real contacts named `"Testimony Namukasa"` (`is_test_contact = false`) are **never** excluded.
    3. Contacts with `is_test_contact = true` are excluded and counted in `excluded_test_contacts`.
    4. Two calls to the same person in the **same** system 2 minutes apart are **both** counted (`2` rows, never merged).
    5. A Landlord Awareness Call and a Landlord Ops Verification Review for the same person across two **different** systems within 2 minutes are merged into `1` physical call and counted in `excluded_cross_source_dupes`.
    6. A timestamped Calling Center dial without a saved outcome is included in `Calls made` with `outcome = 'awaiting_result'`.
- **Unit tests (`src/hooks/__tests__/useStaffCallingReport.test.ts`)**:
  - 6 unit tests covering `formatCallsMadeHeadline`, `computeStats`, `buildCustomDaysPeriodWindow` parity with Week/Month windows, and `"Wrong number"` / `"Phone off"` category rows + `sampleNotes` in Section 5.
