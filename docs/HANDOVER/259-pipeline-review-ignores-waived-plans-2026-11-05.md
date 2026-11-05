# 259 — Nakitende Jumeirah's renewal could not pass the review (waived plan counted as unpaid)

**Date:** 2026-11-05 · **Status:** migration written, dry-run PASSED (rolled back), **NOT YET RUN**. Run together with doc 258's migration (also not yet run).

## Symptom
Her renewal request `51ecc2d8` (posted 06:01 UTC by SHAFEEQ SSENABULYA) was returned for correction twice by Tenant Ops (07:33, 07:46) and sits as `rejected`. The reviewer's check could not pass.

## Cause
`_pipeline_auto_checks`, check `ao_tenant_ok`, fails a tenant whose repayment rate on earlier plans (last 180 days) is below 60%. Plan `406ed7bc` (CFO-waived, doc 254) counts as 216,000 of 552,000 repaid, so the tenant read (216,000+90,000)/(552,000+90,000) = 48% -> `fail`. `rent_pipeline_tenant_history` (dashboard tenant history) counted the same plan as fully expected: repayment_rate 47.7, assessment `poor`. Same flaw as the capacity check in doc 255.

## Fix
`supabase/migrations/20261105170000_pipeline_review_ignores_waived_plans.sql` patches both functions in place from their live definitions (anchor must match exactly once or it aborts). A plan with an audit row `rent_plan_balance_waived%` is excluded from the 180-day rate in `_pipeline_auto_checks`, and gets expected_to_date 0 in `rent_pipeline_tenant_history`. It still counts as a funded/completed plan in the counts.

## Dry run (rolled back)
`ao_tenant_ok`: fail "repaid 48% on 2 earlier plan(s)" -> pass "repaid 100% on 1 earlier plan(s)". History: repayment_rate 47.7 -> 100.0, assessment poor -> good, expected_to_date 642,000 -> 90,000; plan counts unchanged.

## After running
The returned renewal is still `rejected` (returned for correction): the agent must correct and resubmit it so the review re-runs. Nothing here re-opens it.

## Not changed
Not status-based: the six plans closed `completed` with a shortfall on 2026-09-04 (about 2.2M) are still judged on what they repaid.
