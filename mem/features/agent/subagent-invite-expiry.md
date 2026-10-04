---
name: Sub-agent invite auto-expiry + lead nudge
description: Daily cron expires pending_acceptance agent_subagents invites older than a week and SMS/in-app nudges the lead (parent agent) to resend
type: feature
---

# Sub-agent invite auto-expiry + lead nudge

## What

`agent_subagents` rows with `status='pending_acceptance'` that lapse their `expires_at` (normally `created_at + 7 days`, extended on resend) are auto-flipped to `status='expired'`, and each affected lead (parent agent) gets a single consolidated reminder nudge to resend.

## Path

1. pg_cron job `expire-subagent-invites-daily` (07:00 UTC, job id 76) → edge fn `expire-subagent-invites`.
2. Selects pending invites where `expires_at < now()` OR (`expires_at IS NULL` AND `created_at < now() - 7d`).
3. Bulk `UPDATE ... status='expired'`. Safe: `award_subagent_registration_bonus` trigger only pays on the `verified` transition.
4. Groups expired invites per `parent_agent_id`; per lead: inserts one `notifications` row (type `warning`) AND sends one Africa's Talking SMS nudge.

## Resend reactivates

`resend-subagent-invite` accepts both `pending_acceptance` AND `expired` links; it mints a fresh `acceptance_token`, sets `expires_at = now()+7d`, and resets `status='pending_acceptance'`.

## Frontend

`SubAgentsList` has an `expired` status filter chip + red "Invite expired" badge; the Resend button shows for both `pending_acceptance` and `expired`. `MyParentAgentCard` already classifies `expired` and prompts the recruit to ask for a re-send.

## Fragility

Cron-driven. If `expire-subagent-invites-daily` flips `active=false`, invites never expire and leads stop getting nudges (silent). Check CFO → Reconcile → Scheduled Jobs Health.