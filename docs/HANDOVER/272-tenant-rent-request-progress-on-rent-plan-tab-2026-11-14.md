# 272 — Tenants can follow their rent request on the Rent Plan tab

**Date:** 2026-11-14 · **Asked by:** Josh (CTO) · **Status:** code change on `dev/financial-ops`, tests pass, **NOT PUSHED, NOT LIVE.** Frontend only, read-only.

## What was asked

After sending a rent request, the tenant's "Your Rent Plan" tab only said "Your rent plan details will appear here once your account is set up." The tenant should see the progress of their request there.

## What was found

- `RentPlanSummaryCard` is an unconnected placeholder: it is never given data, so it always shows the empty text.
- "Track my request" on the "Your request is under review" screen went to the tenant home, which shows nothing about the request.
- A tenant may read their own `rent_requests` row (policy "Tenants view own requests"). `rent_request_stage_events` and the audit tables are staff-only, so the timeline is built from the row's status and dates.
- Statuses in production: `service_center_review` 3,804, `repaying` 981, `rejected` 949, `completed` 894, `deleted_by_agent` 176, `funded` 53, `cancelled` 52, `coo_approved` 18, `pending` 13, `partner_ops_approved` 5.

## Fix

- `src/lib/rentRequestProgress.ts`: maps every status to five tenant steps (Request sent → Checking your details → Final approval → Rent paid to your landlord → Your Rent Plan), with a headline and next step in plain words. Rejected / cancelled / withdrawn stop after the check and say what to do. Unknown statuses show as "checking", never as approved. Step dates come only from the row (`created_at`, `service_center_reviewed_at`, `coo_reviewed_at`/`approved_at`, `disbursed_at`/`funded_at`, `rejected_at`).
- `src/hooks/useMyRentRequest.ts`: the tenant's latest request, refreshed every minute.
- `src/components/tenant/RentRequestProgressCard.tsx`: the timeline, days since sent, amounts (rent, total to repay, each day, period) and the support number.
- `TenantDashboard` Rent Plan tab: shows the progress card when the tenant has a request; the placeholder summary shows only when there is no request or the Rent Plan is active.
- `TenantsOnboarding`: "Track my request" opens `/dashboard/tenant?tab=rent-plan`.

## Tested

`src/lib/rentRequestProgress.test.ts` (9: every status, stopped states, unknown status, no invented dates, day count) and `src/components/tenant/RentRequestProgressCard.test.tsx` (2). Related tests: only RoleGating and AuthSignupName fail, as before this change. Not checked in a signed-in browser (needs the tenant's password).

## Not changed

The tenant home still shows nothing about a pending request; adding a compact version of this card there is a natural next step. The rejection reason is not shown to tenants (it is staff wording).
