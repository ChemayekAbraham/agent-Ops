---
name: Weekly plans vs daily eligibility gate
description: Weekly rent plans are tracked separately from the agent daily posting gate; they only re-enter the gate after a full week unpaid; frontend gate must mirror server active_count and raw/effective pct
type: feature
---
Rule (2026-09-08):
- `v_agent_daily_eligibility` excludes weekly plans (`repayment_frequency='weekly'` or `rent_request_is_weekly_shape`) from `active_count`, `expected_daily`, `paid_today/yesterday` and all pct/coverage columns.
- Exception: a weekly plan is **lapsed** when `repayment_starts_on + 7 <= today` AND no `agent_collections` row (> 0) for that plan/tenant in the last 7 Kampala days. Lapsed weekly plans re-enter the daily gate at their `daily_repayment` until a collection lands.
- View/RPC expose `weekly_plan_count`, `weekly_lapsed_count`, `weekly_expected_week` (= daily_repayment x 7), plus `raw_today_pct`, `raw_yesterday_pct`.
- Trigger `enforce_agent_daily_eligibility()` is unchanged: allow when `active_count = 0`, else block when `max(effective_pct, raw_today_pct, raw_yesterday_pct) < 0.50`.
- Frontend (`useAgentCapacityMap`) MUST gate on server `active_count` (`daily_gate_count`) and the same best-pct rule — never on the raw count of all active rent_requests. Fallback path (RPC failure) skips weekly plans.
- Frequency corrections for mis-stamped plans are explicit data fixes (UPDATE repayment_frequency + system_event), never inferred from 30-day shape. Mwaka Isaac's plan `33e55b8f-...` corrected to weekly on 2026-09-08.
