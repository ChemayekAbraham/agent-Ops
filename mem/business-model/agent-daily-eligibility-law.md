---
name: Agent Daily Eligibility Law
description: 20% yesterday-collection threshold gates agent ability to post new rent requests; "Good" green rating when met
type: feature
---
Rule (introduced 2026-05-23):
- For every active agent (has ≥1 active rent_request), compute yesterday's collection ratio = `paid_yesterday / sum(daily_repayment of active rents)`.
- If ratio ≥ **20%** → `daily_status = 'good'` → ALLOWED to post new rent requests today, badged green "Good".
- If ratio < 20% → `daily_status = 'blocked'` → BLOCKED from posting new rent requests today.
- Starter agents (no active rents) are always allowed (first post).
- Constant: `DAILY_ELIGIBILITY_THRESHOLD = 0.20` in `src/hooks/useAgentCapacityMap.ts`.
- Computed client-side in `useAgentCapacityMap` and surfaced via `AgentCapacity.daily_status`, `can_post_rent_today`, `paid_yesterday`, `yesterday_response_pct`.
- 5-tier human rating based on yesterday's collection ratio (`AgentCapacity.daily_rating`, helper `classifyDailyRating`, thresholds `DAILY_RATING_THRESHOLDS`):
  - ≥ 50% → **Very Good** (allowed, emerald)
  - 20% – <50% → **Good** (allowed, green) — 20% is the unblock line
  - 15% – <20% → **Fair** (BLOCKED, amber)
  - 5% – <15% → **Bad** (BLOCKED, orange)
  - < 5% → **Very Bad** (BLOCKED, red)
  - no active rents → **Starter**
- UI:
  - `AgentRentCapacitySelfCard` shows a green/red/violet law banner.
  - `AgentRentRequestDialog` shows banner and gates `handleSubmit` (early-return with toast + submission error) when `daily_status === 'blocked'`.
  - `AgentCapacityBadge` (executive views) prepends a colored 5-tier rating chip (`Very Good` / `Good` / `Fair · Blocked` / `Bad · Blocked` / `Very Bad · Blocked`, or `New` for Starter) before the 7-day tier chip.
- The agent's 7-day responsiveness tier (Positive/Fair/Bad/Very Bad/Starter) is unchanged and continues to drive per-tenant rent limits.
