---
name: Agent eligibility unblock notifications
description: Instant SMS + in-app toast when an agent crosses today's 20% collection threshold and becomes eligible to post new rent requests
type: feature
---

When an `agent_collections` row is inserted, trigger `trg_detect_agent_unblock` recomputes today's eligibility via `get_agent_daily_eligibility(ARRAY[agent_id])` (Kampala TZ). If `effective_pct >= 0.20` AND `active_count > 0` AND no event yet today, it:

1. Inserts a row in `agent_eligibility_unblock_events` (UNIQUE on `agent_id, kampala_day`) capturing reference values: `paid_today`, `expected_daily`, `ratio_pct`, `active_count`, `trigger_collection_id`.
2. Emits `system_event` `agent.eligibility.unblocked` with the same payload.
3. Fires `notify-agent-unblocked` edge function via `pg_net.http_post` (vault `service_role_key`), which sends an SMS via Africa's Talking and flips `sms_sent=true`.

Frontend: `useAgentUnblockToast(agentId)` (mounted in `AgentDashboard`) checks for today's unseen event on mount and listens to realtime INSERTs. Shows a sonner success toast with the reference values, then sets `toast_seen_at` so it never re-fires the same day.

RLS: agents see/update only their own events; manager/super_admin/coo see all.
