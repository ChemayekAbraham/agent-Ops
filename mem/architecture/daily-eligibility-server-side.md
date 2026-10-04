---
name: Daily Eligibility Law (server-side)
description: Postgres view + RPC + BEFORE INSERT trigger that authoritatively decide whether an agent may post a new rent request; Kampala TZ, agent_collections-sourced
type: feature
---
As of 2026-05-25 the **Daily Eligibility Law** lives in Postgres, not the browser.

- View: `public.v_agent_daily_eligibility`
  - Denominator: `SUM(rent_requests.daily_repayment)` for active statuses, excluding rent_requests with an `agent_tenant_float_reversals` row AND `amount_repaid <= 0`.
  - Numerator: `public.agent_collections.amount` summed in **Africa/Kampala** TZ buckets for today and yesterday. **NOT** sourced from `repayments` — that path was missing rows for agent-initiated collections, which is what caused agents like WAMBULA AVIN to show 0 paid even after collecting.
  - `effective_pct = max(today_pct, yesterday_pct)` (best-of-today/yesterday law preserved).
- RPC: `public.get_agent_daily_eligibility(p_agent_ids uuid[])` returns batched rows. `SECURITY DEFINER`, `SET search_path = public`. Granted to `authenticated, anon, service_role`.
- Trigger: `tr_enforce_agent_daily_eligibility BEFORE INSERT ON rent_requests` calls `enforce_agent_daily_eligibility()`. Blocks new rows with `check_violation` / `DAILY_ELIGIBILITY_BLOCKED` when `active_count > 0 AND effective_pct < 0.20`. Starter agents (no active rents) always pass. Migrations / system inserts bypass with `SELECT set_config('app.bypass_daily_eligibility','true', true);`.
- Frontend: `useAgentCapacityMap` and `AgentRentCapacityPanel` call the RPC for `paid_today / paid_yesterday / today_pct / yesterday_pct / effective_pct / expected_daily`. The 7-day DRR (`response_rate`, `paying_tenants_last_week`) still comes from `repayments` — it is a tier metric, not the daily gate.
- Threshold constant `DAILY_ELIGIBILITY_THRESHOLD = 0.20` and `classifyDailyRating` live in `src/hooks/useAgentCapacityMap.ts`; mirror any future change in the trigger.
