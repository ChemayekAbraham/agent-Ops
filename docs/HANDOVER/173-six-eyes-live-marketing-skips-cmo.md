# 173 — Six-eyes requisition approval now LIVE; Marketing has no CMO stage (2026-09-30)

## Request
Josh: Promrose's requisitions must go COO → CEO → CFO. Chose "deploy doc 120 properly" and
"remove the CMO entirely" for Marketing.

## What was wrong (verified live)
- Promrose Katusiime (Marketing) had SRQ-00182 (UGX 1,400,000) and SRQ-00184 (UGX 1,240,000) sitting at
  `supervisor`, waiting on the CMO (`staff_requisition_department_routes`: marketing → `cmo`).
  SRQ-00146 (Enock, UGX 200,000) had waited there since 09-23.
- **Doc 120's migration `20260924130000` had never been applied**: no `staff_requisition_six_eyes_guard_trg`,
  and `staff_requisition_route` still contained `v_final := 'ceo'` / COO-goes-straight-to-CFO.

## What was done
1. Redeployed `staff-requisition-decide`, `staff-requisition-submit`, `growth-commission-claim` via Lovable
   (from commit 94492752f7, no code changes), **before** the migration.
2. Moved SRQ-00146 / 00182 / 00184 (no sign-offs) from `supervisor` to `coo`, as a plain UPDATE **before** the
   guard existed, with a `comment` event on each. The guard was not disabled or bypassed.
3. Applied `20260924130000` to production (statements run via query_database; content identical to the file).
   In-flight rows re-routed by it: SRQ-00158 (Angwen Sarah, CFO requester) back to `coo`; SRQ-00171 now
   `final_stage = cfo` (still at `ceo`).
4. Set Marketing's department route to `coo` (`20260930180000_marketing_requisitions_skip_cmo_stage.sql`), so new
   Marketing requisitions enter at the COO.

## Verified after
Guard trigger present; `staff_requisition_route` has no `v_final := 'ceo'`; marketing route = `coo`; the three
Marketing rows at `coo`, `final_stage = cfo`.

## Not changed
- The CMO role and its holders are untouched; only the approval stage is dropped for Marketing.
- Other departments keep their department-head stage.
- SRQ-00148 and SRQ-00145 (credited pre-fix, see doc 120) are still Josh's call.
