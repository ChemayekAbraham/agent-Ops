---
name: Agent Daily Activity & Growth Report
description: Morning cron email reporting YESTERDAY's agent/sub-agent field activity + network growth as a branded PDF attachment (Gmail connector)
type: feature
---
Edge function `agent-growth-daily-report` emails a combined daily activity + growth PDF.

- **Recipients (fixed):** benjamin@welile.com, pexpert46@gmail.com
- **Schedule:** pg_cron `agent-growth-daily-report-0700-eat` at `0 4 * * *` (04:00 UTC = 07:00 EAT).
- **Report day:** runs in the morning, so it reports the PREVIOUS EAT calendar day ("yesterday"). Default `reportDate = eatYesterday()`; override with body `{ date: 'YYYY-MM-DD' }`.
- **Data (combined):**
  - `get_agent_daily_activity_report(p_date)` → yesterday's DAILY metrics: active_agents, active_subagents (distinct agents/sub-agents with any tracked field action that day), houses_listed, rent_requests_posted, repayments (count/amount), collections (count/amount), visits, new_subagents, subagent_invites + supporter_invites, plus a per-agent `top_agents` leaderboard. EAT day = `(p_date::timestamp AT TIME ZONE 'UTC') - interval '3 hours'` .. +1 day.
  - `get_agent_leaderboard_stats('daily')` → trailing 30-day growth series, top recruiters, invitee pipeline (context only). Totals from this RPC are NOT used for KPIs.
  - `get_agent_weekly_growth_forecast()` → week-over-week headcount for agents AND sub-agents: `last_week` (headcount at end of last week = start of this week), `now` (current total), `next_week_forecast` = now + round(trailing 4-week avg new joins/week). Weeks start Monday (EAT). Rendered as a "Weekly Headcount & Forecast" table in both PDF and email.
- **PDF:** server-side jsPDF + jspdf-autotable: header (report day), 8 DAILY KPI cards, Executive Summary, Weekly Headcount & Forecast table, Top Active Agents (yesterday) table, trailing 30-day growth chart, Top Recruiters, Invitee Pipeline.
- **Delivery:** Gmail connector (`GOOGLE_MAIL_API_KEY` + `LOVABLE_API_KEY`) via `messages/send` with a multipart/mixed MIME body so the PDF rides as a real ATTACHMENT. The Lovable email queue (`sendLovableEmail`) cannot carry attachments — do not route this through it.
- **Idempotency:** one `system_events` row (`event_type='agent_growth_daily_report'`, `metadata.report_date` = the reported EAT day) per report day; bypass with `{ force: true }`.

Frontend Export PDF button (`AgentLeaderboardPanel.tsx` → `generateAgentGrowthReportPdf`) is the executive leaderboard export and is independent of this email.
