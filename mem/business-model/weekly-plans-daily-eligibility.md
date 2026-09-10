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
- **Daily-equivalent cap (2026-09-10)**: the gate's per-plan day expectation is `LEAST(agent_expected_day_plans.expected_ugx, rent_requests.daily_repayment)` (uncapped only when `daily_repayment <= 0`). `pin_agent_expected_day` / `rent_plan_schedule_days` legitimately pin a weekly instalment (daily x 7) on the tenant's weekly day; charging that whole week to ONE day of the agent's gate blocked agents whose weekly tenant had genuinely paid (Joseph Matovu, plan `33e55b8f-...`: paid UGX 163,000 vs a 330,519 one-day denominator → 47.6% → blocked; capped at 47,217 → 79.6% → allowed). Tenant schedules, arrears, monitoring and money records are untouched — the cap exists only in `v_agent_daily_eligibility`.
