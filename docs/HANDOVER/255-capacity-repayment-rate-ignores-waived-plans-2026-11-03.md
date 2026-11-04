# 255 — Renewal blocked after a plan balance was waived (capacity repayment rate)

**Date:** 2026-11-03 · **Status:** APPLIED LIVE 2026-11-03 to `byrzshwlentqvktcksem`, verified (function body, grants intact, rate recomputed).

## Symptom
After doc 254 closed Nakitende Jumeirah's plan (`406ed7bc`, 336,000 waived), her agent still could not renew: "This tenant is behind on rent (only 48% paid back)".

## Cause
`get_agent_rent_request_capacity` (called by trigger `enforce_agent_rent_request_capacity` on rent_requests insert, hence by `renew_rent_request`) rates a tenant on sum(amount_repaid)/sum(total_repayment) over 180 days of plans. The waived plan counts 216,000/552,000 paid, so (216,000+90,000)/(552,000+90,000) = 48% < 60% -> 'defaulting', limit 0. The plan screen's "active" test (funded/repaying only) let the button show, but the server refused.

## Fix
`supabase/migrations/20261103090000_capacity_repayment_rate_ignores_waived_plans.sql`: plans with an audit_logs row `action_type LIKE 'rent_plan_balance_waived%'` (record_id = plan id) are excluded from the rate. Her rate is now 90,000/90,000 = 100% (premium). Rest of the function unchanged; grants kept; not in critical_function_baselines.

## Rule for future waivers
Any waiver migration must write an audit row with action_type starting `rent_plan_balance_waived` against the plan id, or the tenant will be judged on the unpaid part.

## Not changed
`TenantProfileView` total-owing (funded minus repaid) still includes the waived 336,000 as a display figure; it does not block renewal.
