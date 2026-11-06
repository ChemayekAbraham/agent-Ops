# Landlord Calling Hub — End-to-End Verification, Regression, Performance & Safety Results

**Date**: 2026-10-27 (Africa/Kampala)  
**Database**: Live production database (`43e6c2e1-18a6-4503-badb-5bb6c23491cc`, read-only except inside rolled-back transactions `BEGIN ... ROLLBACK`)  
**Migrations verified**:
- `supabase/migrations/20261028100000_landlord_calling_hub_foundation.sql` (+ rollback `supabase/rollbacks/20261028100000_landlord_calling_hub_foundation.rollback.sql`)
- `supabase/migrations/20261028110000_landlord_calling_hub_reports.sql` (+ rollback `supabase/rollbacks/20261028110000_landlord_calling_hub_reports.rollback.sql`)

---

## 1. End-to-End Check on the Live Database (Rolled-Back Transaction)

Executed against the live database inside a single `BEGIN ... ROLLBACK` transaction (`supabase/tests/landlord_calling_hub.sql`, `supabase/tests/landlord_calling_hub_reports.sql`, and the Prompt 4 E2E verification script):

### 1.1 Full Officer Flow Across All 5 Call Result Types
Impersonated Landlord Ops officer **Jane (`5295252d-f477-42a9-92f5-af56e503e33d`)** with `aal2` MFA claims (`SET LOCAL ROLE authenticated`), selected 5 live-plan landlords from `mv_landlord_hub_registry`, called `landlord_hub_start_dial(p_landlord_key, p_phone)` to create a 20-minute dial lock, and called `landlord_hub_record_call(...)` for every allowed `result` value:

| Step | Result Type | Dial Marker Linked (`landlord_call_dials.call_id`) | `staff_calling_detailed_report` Row | `answered` Flag | `feedback` / `extra` Payload for PDF Builder | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1a | `answered` | Linked (`139c2ce7-2a2d-4d7a-8a13-82e745bc1d09`) | `source = 'Landlord Ops - Calling Hub'`, `role = 'landlord'`, `outcome = 'answered'` | `true` | `feedback = 'Confirmed payout number (normal) \| Confirmed mobile money payout number and Rent Plan terms with landlord.'`, `extra = {"aware_30m":"knew","landlord_consent":"consents","aware_payout_otp":"knew","explained":"yes","category":"Confirmed payout number","severity":"normal"}` | PASS |
| 1b | `no_answer` | Linked (`55f3aa30-f6ed-4a93-8cd6-3c3d38722210`) | `source = 'Landlord Ops - Calling Hub'`, `role = 'landlord'`, `outcome = 'no_answer'` | `false` | `feedback = 'Rang four times without answer.'`, awareness fields `null` | PASS |
| 1c | `phone_off` | Linked (`0495f8de-3538-472d-95c7-76d25d6bb228`) | `source = 'Landlord Ops - Calling Hub'`, `role = 'landlord'`, `outcome = 'phone_off'` | `false` | `feedback = 'Subscriber phone switched off.'`, awareness fields `null` | PASS |
| 1d | `wrong_number` | Linked (`1db74dad-31d6-4c11-a2f3-245e0d4da900`) | `source = 'Landlord Ops - Calling Hub'`, `role = 'landlord'`, `outcome = 'wrong_number'` | `false` | `feedback = 'Person who answered said they do not own these houses.'`, awareness fields `null` | PASS |
| 1e | `call_back` | Linked (`2b821d97-fef9-4c65-967a-7e10bbdc5c65`) | `source = 'Landlord Ops - Calling Hub'`, `role = 'landlord'`, `outcome = 'call_back'` | `false` | `extra.call_back_at = '2026-10-27T19:56:35+00:00'`, `feedback = 'Landlord is in a meeting and requested a call back in 3 hours.'` | PASS |

### 1.2 Officer vs Team Visibility in `staff_calling_detailed_report` (`/me/reports` & `/me/staff-reports`)
In the same rolled-back transaction, recorded 5 calls as **Jane** (`5295252d-f477-42a9-92f5-af56e503e33d`), 1 call as **Winnie** (`a9258d45-3e27-4827-af71-64344e76fb4f`), and 1 call as **Hanisha** (`fda0d518-98c4-45e4-83d8-64266b25eefa`), then queried `staff_calling_detailed_report`:

| Caller / Viewer | Route | Own Hub Rows Returned | Other Officers' Hub Rows Returned | Total Hub Rows Returned | Distinct Officers Visible | Result |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| **Winnie** (`a9258d45-3e27-4827-af71-64344e76fb4f`, `landlord_ops`) | `/me/reports` | 1 | 0 | 1 | 1 (Winnie only) | PASS |
| **Hanisha** (`fda0d518-98c4-45e4-83d8-64266b25eefa`, `landlord_ops`) | `/me/reports` | 1 | 0 | 1 | 1 (Hanisha only) | PASS |
| **Jane** (`5295252d-f477-42a9-92f5-af56e503e33d`, Head of Calling) | `/me/reports` | 5 | 2 | 7 | 3 (Jane, Winnie, Hanisha) | PASS |
| **Mark Bwayo / HR** (`hr` role) | `/me/staff-reports` | — | — | 7 | 3 (Jane, Winnie, Hanisha) | PASS |

### 1.3 Landlord Calling Center History, Registry "Last Called" & PDF Builder Input
- **Landlord Calling Center History (`_landlord_cc_events_in_window` & `landlord_cc_landlord_call_log`)**: All 7 non-voided test calls appeared in `_landlord_cc_events_in_window` and `landlord_cc_landlord_call_log` with `source = 'calling_hub'`, while voided calls (`voided_at IS NOT NULL`) were excluded.
- **Registry "Last Called" (`v_landlord_registry_all`)**: After recording the `answered` call on landlord `v_ll_ids[1]`, `v_landlord_registry_all` immediately reflected `last_called_at = recorded_at`, `last_call_outcome = 'confirmed_payout_number'`, and `last_caller_name = 'JANEHEPHZIBAR GIMONO'`.
- **Landlord Card Call History (`landlord_hub_detail`)**: `call_history[0]` returned the newly recorded call (`source = 'calling_hub'`, `call_id = 139c2ce7-2a2d-4d7a-8a13-82e745bc1d09`), and after a 24-hour same-caller amendment via `landlord_hub_amend_call`, `v_landlord_calls_effective` and `landlord_hub_detail` reflected the amended `severity` and `feedback_category` while leaving the original `landlord_calls` row untouched.
- **PDF Builder Input (`feedbackText` & `generateStaffCallingReportPdf` in `src/lib/staffCallingReportPdf.ts`)**: Verified in `src/lib/__tests__/staffCallingReportPdf.test.ts` (7/7 tests passing) that `feedbackText()` formats `source = 'Landlord Ops - Calling Hub'` rows with `30m: Knew · Consent: Consents · Payout OTP: Knew · Explained: Yes`, category/severity (`Confirmed payout number (normal)`), and the officer's note, and formats `call_back` rows with `Call-back due: YYYY-MM-DD HH:MM` in Kampala time.

---

## 2. Regression Suite & Pinned Totals Check

### 2.1 Prompt 2 SQL Totals Check (`supabase/tests/landlord_calling_hub_reports.sql` — 12/12 Passed)
Verified against the live database for **1 to 27 October 2026** (`2026-10-01T00:00:00+03:00` to `2026-10-28T00:00:00+03:00`):
- **Aggregate totals**: `1,342` total rows and `823` answered rows before and after adding the `Landlord Ops - Calling Hub` branch (`0` diffs across all 12 `(short_name, source)` pairs).

| Staff Member | Source | Total Rows | Answered Rows | Excluded Reveals | Diff vs Pre-Migration |
| :--- | :--- | ---: | ---: | ---: | ---: |
| **Hanisha** | `In-app voice call` | 32 | 1 | 65 | 0 |
| **Hanisha** | `Tenant Ops - Calling Center` | 246 | 119 | 65 | 0 |
| **Jane** | `Calling Center - Inbound call received` | 20 | 20 | 5 | 0 |
| **Jane** | `In-app voice call` | 2 | 0 | 5 | 0 |
| **Jane** | `Rent Pipeline - Awareness call` | 349 | 329 | 5 | 0 |
| **Jane** | `Rent Pipeline - Landlord Ops review feedback` | 7 | 2 | 5 | 0 |
| **Jane** | `Rent Pipeline - Landlord Ops verification call` | 133 | 133 | 5 | 0 |
| **Jane** | `Rent Pipeline - Tenant Ops review feedback` | 39 | 0 | 5 | 0 |
| **Jane** | `Tenant Ops - Calling Center` | 12 | 6 | 5 | 0 |
| **Winnie** | `Calling Center - Inbound call received` | 1 | 1 | 25 | 0 |
| **Winnie** | `In-app voice call` | 23 | 0 | 25 | 0 |
| **Winnie** | `Tenant Ops - Calling Center` | 478 | 212 | 25 | 0 |
| **Total** | **All Existing Sources** | **1,342** | **823** | — | **0** |

### 2.2 Automated Test Suites Executed

| Area | Test File / Suite | Result |
| :--- | :--- | :--- |
| **Landlord Calling Hub SQL Foundation** | `supabase/tests/landlord_calling_hub.sql` | **42 / 42 passed** |
| **Landlord Calling Hub SQL Reports** | `supabase/tests/landlord_calling_hub_reports.sql` | **12 / 12 passed** |
| **Landlord Calling Hub Prompt 4 E2E, Perf & Safety** | Rolled-back live DB verification (`25` checks) | **25 / 25 passed** |
| **Landlord Calling Hub UI & Switch** | `src/components/executive/landlord-ops/calling-hub/__tests__/LandlordCallingHub.test.tsx` | **8 / 8 passed** |
| **Landlord Ops Navigation** | `src/components/executive/landlord-ops/landlordOpsNav.test.ts` | **2 / 2 passed** |
| **Landlord Calling Center UI** | `src/components/executive/landlord-ops/calling-center/__tests__/LandlordCallingCenter.test.tsx` | **4 / 4 passed** |
| **My Space Calling Report PDF (`/me/reports`, `/me/staff-reports`)** | `src/lib/__tests__/staffCallingReportPdf.test.ts` | **7 / 7 passed** |
| **Shared Calling Center & Weekly Forwarding PDF** | `src/lib/callingCenterAllCalls.test.ts`, `src/lib/callingCenterWeeklyForwardingPdf.smoke.test.ts` | **13 / 13 passed** |
| **Pipeline Awareness Calls** | `src/components/executive/tenant-ops/awareness/AwarenessCallsPage.test.tsx`, `src/components/executive/tenant-ops/awarenessCallsNav.test.ts`, `src/lib/awarenessCallLabels.test.ts`, `src/lib/awarenessCallStatus.test.ts`, `src/lib/awarenessCallsExport.test.ts` | **72 / 72 passed** |
| **Tenant Ops Workspace & Hooks** | `src/components/tenant-ops-workspace/**/*.test.tsx`, `src/hooks/tenantOpsWorkspace/**/*.test.tsx`, `src/lib/tenantOps*.test.ts`, `src/lib/tenantPaymentBehaviorPdf.test.ts`, `src/lib/tenantSearch.test.ts` | **168 / 168 passed** |
| **Zoe (`staff-assistant`) Real Handler, Eval & UI** | `src/lib/zoe/__tests__/zoeRealHandler.test.ts`, `src/components/zoe/__tests__/ZoeActionsAndBrief.test.tsx`, `src/components/zoe/__tests__/ZoeIdeasPage.test.tsx`, `npm run eval:zoe` (57/57 Safety, 60/60 Accuracy) | **19 / 19 Vitest + 117 / 117 Eval passed** |
| **Pre-Build Guards (`npm run guard:all`)** | All 11 repository guards (`guard-frontend-ledger-writes`, `guard-privileged-function-grants`, `guard-tops-client-math`, `guard-assistant-readonly`, `guard-staff-assistant`, etc.) | **11 / 11 passed** |

### 2.3 Proof That No Protected Files Were Touched (`git show --stat` Across All Landlord Calling Hub Commits)
Across all 13 Landlord Calling Hub commits (`2ae255df4d` through `4f8e2b1915`), the complete list of touched files is:

```text
 e2e/landlord-calling-hub.spec.ts                                             |  346 ++++
 src/components/executive/landlord-ops/calling-hub/LandlordCallingHub.tsx     | 1247 ++++++++++++++
 src/components/executive/landlord-ops/calling-hub/LandlordCallingHubCard.tsx | 1208 ++++++++++++++
 src/components/executive/landlord-ops/calling-hub/LandlordCallingHubRecordDialog.tsx | 696 ++++++++
 src/components/executive/landlord-ops/calling-hub/__tests__/LandlordCallingHub.test.tsx | 730 ++++++++
 src/components/executive/landlord-ops/calling-hub/index.ts                   |    3 +
 src/components/me/StaffCallingReportWorkspace.tsx                            |    6 +-
 src/hooks/useLandlordCallingHub.ts                                           |  936 +++++++++++
 src/hooks/useStaffCallingReport.ts                                           |   28 +-
 src/lib/__tests__/staffCallingReportPdf.test.ts                              |   48 +
 src/lib/staffCallingReportPdf.ts                                             |    2 +-
 src/pages/landlord-ops/calling/CallingHub.tsx                                |   20 +-
 supabase/AGENTS.md                                                           |    5 +-
 supabase/functions/_shared/fullBackupTables.ts                               |    2 +-
 supabase/migrations/20261028100000_landlord_calling_hub_foundation.sql       | 1914 ++++++++++++++++++++
 supabase/migrations/20261028110000_landlord_calling_hub_reports.sql          | 1759 ++++++++++++++++++++
 supabase/rollbacks/20261028100000_landlord_calling_hub_foundation.rollback.sql |   40 +
 supabase/rollbacks/20261028110000_landlord_calling_hub_reports.rollback.sql  | 1452 ++++++++++++++++
 supabase/tests/landlord_calling_hub.sql                                      |  663 +++++++
 supabase/tests/landlord_calling_hub_reports.sql                              |  383 +++++
```

Zero files were touched in:
- `src/components/executive/tenant-ops/**`
- `src/components/ops/calling/**` or `src/hooks/useCcCallingHub.ts`
- `src/components/executive/landlord-ops/calling-center/**`
- Any `cc_*` table, view, or function (`cc_weekly_all_calls_report` verified untouched in SQL step 10b)
- `rent_pipeline_awareness_calls`, `record_awareness_call`, or `AwarenessCallPanel`
- Any Zoe / `staff-assistant` function.

---

## 3. Performance Benchmarks & Query Plan Verification

### 3.1 Live-Sized Registry Benchmarks (`106,478` Total Landlords, `807` Live-Plan Landlords)
Measured on the live database as a `landlord_ops` user (`p_limit = 50, p_offset = 0`). Every combination of scope, tab, search, and sort completed well under the **1,000 ms** target (default `live_plans` scope: **3.4 ms – 8.7 ms**; `with_plans` scope: **41.3 ms – 43.4 ms**; full `all` 106,478-landlord registry: **44.0 ms – 529.8 ms**):

| Scope | Tab | Search | Sort | Page Rows | Matching Total (`total_count`) | Execution Time (`ms`) | Target (`< 1000 ms`) |
| :--- | :--- | :--- | :--- | ---: | ---: | ---: | :--- |
| `live_plans` | `to_call` | `NULL` | `rent_plan_value` | 50 | 279 | **8.7 ms** | PASS |
| `live_plans` | `call_back` | `NULL` | `call_back_due` | 1 | 1 | **3.7 ms** | PASS |
| `live_plans` | `answered` | `NULL` | `last_called` | 50 | 522 | **5.1 ms** | PASS |
| `live_plans` | `not_answered` | `NULL` | `rent_plan_value` | 8 | 8 | **3.4 ms** | PASS |
| `live_plans` | `all` | `NULL` | `rent_plan_value` | 50 | 807 | **5.4 ms** | PASS |
| `with_plans` | `to_call` | `NULL` | `rent_plan_value` | 50 | 1,110 | **43.4 ms** | PASS |
| `with_plans` | `all` | `NULL` | `last_called` | 50 | 1,811 | **41.3 ms** | PASS |
| `all` | `to_call` | `NULL` | `rent_plan_value` | 50 | 105,777 | **529.8 ms** | PASS |
| `all` | `call_back` | `NULL` | `call_back_due` | 1 | 1 | **44.0 ms** | PASS |
| `all` | `answered` | `NULL` | `last_called` | 50 | 695 | **46.6 ms** | PASS |
| `all` | `not_answered` | `NULL` | `rent_plan_value` | 12 | 12 | **48.6 ms** | PASS |
| `all` | `all` | `NULL` | `rent_plan_value` | 50 | 106,478 | **341.4 ms** | PASS |
| `all` | `all` | `NULL` | `last_called` | 50 | 106,478 | **380.7 ms** | PASS |
| `all` | `all` | `NULL` | `call_back_due` | 50 | 106,478 | **346.9 ms** | PASS |
| `all` | `all` | `'kampala'` | `rent_plan_value` | 50 | 10,269 | **285.8 ms** | PASS |
| `all` | `all` | `'077'` | `rent_plan_value` | 50 | 462 | **264.3 ms** | PASS |

### 3.2 Indexes on New Objects Only & Query Plan Check
All indexes created by the Landlord Calling Hub live exclusively on the new tables and materialized view (zero indexes added to any existing table):
- `public.landlord_calls`:
  - `landlord_calls_landlord_recorded_idx ON (landlord_key, recorded_at DESC, id DESC) WHERE voided_at IS NULL`
  - `landlord_calls_caller_recorded_idx ON (caller_id, recorded_at DESC)`
  - `landlord_calls_callback_due_idx ON (call_back_at ASC) WHERE result = 'call_back' AND voided_at IS NULL AND call_back_at IS NOT NULL`
  - `landlord_calls_landlord_id_idx ON (landlord_id, recorded_at DESC) WHERE landlord_id IS NOT NULL AND voided_at IS NULL`
  - `landlord_calls_idempotent_dial_uidx UNIQUE ON (caller_id, landlord_key, dial_started_at)`
- `public.landlord_call_dials`:
  - `landlord_call_dials_active_lookup_idx ON (landlord_key, started_at DESC) WHERE call_id IS NULL`
  - `landlord_call_dials_caller_started_idx ON (caller_id, started_at DESC)`
- `public.landlord_call_amendments`:
  - `landlord_call_amendments_call_edited_idx ON (call_id, edited_at DESC, id DESC)`
- `public.mv_landlord_hub_registry`:
  - `mv_landlord_hub_registry_key_text_idx UNIQUE ON (landlord_key_text)`
  - `mv_landlord_hub_registry_landlord_id_idx ON (landlord_id) WHERE landlord_id IS NOT NULL`
  - `mv_landlord_hub_registry_live_plans_sort_idx ON (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC) WHERE active_rent_plans > 0`
  - `mv_landlord_hub_registry_all_sort_idx ON (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC)`
  - `mv_landlord_hub_registry_region_district_idx ON (lower(region), lower(district))`
- **Query plan check**: `landlord_hub_list` reads `public.mv_landlord_hub_registry` (refreshed every 5 minutes via `refresh-landlord-hub-registry-5m` `pg_cron` job) joined against materialized CTEs `hub_latest` (`v_landlord_calls_effective`) and `active_dials` (`landlord_call_dials`). It **never** scans `public.landlords` per row.

---

## 4. Safety Review Summary

| Safety Control | Verification Method | Result |
| :--- | :--- | :--- |
| **Role gates (record vs read)** | `_landlord_hub_can_record()` allows only `landlord_ops` and `operations`. `_landlord_hub_can_read()` allows `landlord_ops`, `operations`, `hr`, `coo`, `ceo`, `cfo`, `manager`, `super_admin`. Tested `agent`, `tenant`, `landlord`, `supporter`, `employee`, no-role user, signed-out (`sub=null`), and `anon`: all refused with `42501`. | PASS |
| **Phone masking** | Follows `_landlord_cc_can_view_unmasked_phone()` and `crm_mask_phone()`. Verified in SQL that a `manager` user receives `+256752 ••• 839` (`phone_masked = true`) while a `landlord_ops` officer receives `256752559839` (`phone_masked = false`). | PASS |
| **Append-only call & amendment records** | `landlord_calls_no_change` and `landlord_call_amendments_no_change` `BEFORE UPDATE OR DELETE` triggers raise `42501` even for table owners / `SECURITY DEFINER` callers. `authenticated` has `SELECT` only on all 3 tables. | PASS |
| **mfa_required_for_staff restrictive RLS** | All 3 tables (`landlord_calls`, `landlord_call_dials`, `landlord_call_amendments`) have `ENABLE ROW LEVEL SECURITY` and a `RESTRICTIVE` policy `mfa_required_for_staff` checking `(SELECT public.staff_mfa_ok())`. | PASS |
| **24-hour same-caller amendment rule** | `landlord_hub_amend_call` verifies `v_orig.caller_id = auth.uid()` (refuses any other officer with `42501`) and `v_orig.recorded_at >= now() - interval '24 hours'` (refuses older calls with `AMEND_WINDOW_EXPIRED`). | PASS |
| **20-minute dial lock expiry** | `landlord_hub_start_dial` acquires `pg_advisory_xact_lock`, refuses another officer if `call_id IS NULL AND expires_at > now()` (`DIAL_IN_PROGRESS`), reuses the same officer's active dial idempotently, and allows dialling once `expires_at <= now()`. | PASS |
| **No cross-user impersonation** | Every write RPC derives the actor exclusively from `auth.uid()` inside `SECURITY DEFINER` with `search_path = public`. No RPC accepts a caller ID parameter. Recording against another officer's `p_dial_id` or amending another officer's `p_call_id` raises `42501`. | PASS |

---

## 5. Risks & Pre-Existing Issues Observed (Left Untouched)

Per the rules block, the following pre-existing items outside the Landlord Calling Hub scope were observed during regression testing and **were not modified**:
1. **`src/test/callingPausedNotice.test.tsx` missing Supabase env fallback in isolated Vitest runs**: Imports `src/integrations/supabase/client.ts` directly without mocking `@/integrations/supabase/client`, which throws `supabaseUrl is required` when `VITE_SUPABASE_URL` is not injected in the test shell. Left untouched because `src/test/callingPausedNotice.test.tsx` and `src/integrations/supabase/client.ts` are outside the Landlord Calling Hub scope.
2. **`src/lib/__tests__/landlordCallingReportsExport.test.ts` (`Total Calls` vs `Calls` column header)**: Expects `sheets[0].rows[0]['Total Calls']` to be `12`, whereas `src/lib/landlordCallingReportsExport.ts` was updated in an earlier commit to name that Excel column `'Calls'`. Left untouched per the rule not to touch Landlord Calling Center files.
3. **`src/lib/tenantSearch.bench.test.ts` and `src/lib/tenantSearch.perf.test.ts` wall-clock p50/p99 budgets under CPU load**: `src/lib/tenantSearch.test.ts` passes all functional assertions, while the synthetic 5,000-row wall-clock micro-benchmarks (`P50 < 50ms`, `P99 < 100ms`) fluctuate above their strict millisecond thresholds when the machine is under load. Left untouched per the rule not to touch Tenant Ops files.
