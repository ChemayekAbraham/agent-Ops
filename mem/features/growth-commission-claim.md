---
name: Growth Commission Claim
description: UGX 50 per new platform user, claimable from My Space by configured beneficiaries; routed CEO -> CFO as a staff requisition with auto wallet credit and a moving counter baseline
type: feature
---
# Growth Commission Claim (2026-08-28)

UGX 50 per new platform user (every new `profiles` row), claimable at any time by
users listed in `growth_commission_beneficiaries` (seeded with Kalyango Timothy).

## Route
My Space card ("Growth commission") → `growth-commission-claim` edge function →
`staff_requisitions` inserted at `stage='ceo'`, `current_approver_role='ceo'`,
`final_stage='cfo'`, `category='growth_commission'` → CEO approves → CFO approves →
existing `_shared/requisitionWalletCredit.ts` credits the wallet.

## Counter baseline
`growth_commission_next_window(_user_id)` (SECURITY DEFINER, caller may only read
their own) returns the next window: start = `max(window_end)` of non-rejected
claims, else `now() - 30 days` on the first claim; end = `now()`. Each claim locks
its own window, so multiple claims may be in flight without overlap. Rejecting a
claim frees its window (counted again next time); the release on final CFO approval
(`status='released'`) is what moves the baseline forward.

## Data / code
- `growth_commission_claims` (claim_code `GCM-00001`, window, user_count, rate, amount,
  status `pending|approved|rejected|released`, requisition_id) — owner-read RLS, writes
  service-role only.
- `growth_commission_beneficiaries` — server-side entitlement, not a client check.
- `staff_requisitions` gained `ceo_decided_by/at/note`; `staff-requisition-decide` now
  advances `ceo → cfo` when `final_stage='cfo'` and sets claim status on reject/credit.
- UI: `src/components/me/GrowthCommissionCard.tsx` (live total + claim history, realtime),
  mounted in `src/pages/me/PersonalHub.tsx`; reviewers see the report in the requisition
  reason (users, window, rate, total).
