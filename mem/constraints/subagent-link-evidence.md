---
name: Sub-agent link requires real agent evidence
description: agent_subagents may never be populated from profiles.referrer_id or the default agent role/capabilities; requires explicit agent activity
type: constraint
---
Every user on the platform is granted the default `agent` role AND default `agent_capabilities` rows. Therefore **neither signal proves someone is a recruited sub-agent**. Any backfill or trigger that links `profiles.referrer_id` → `agent_subagents` using "both hold the agent role" wrongly turns every tenant/funder/landlord an agent registered into a sub-agent (this happened twice: 45,912 rows sourced `agent_invite` in July 2026 and 6,685 rows sourced `referral_link_backfill` on 2026-08-01).

Rules:
- `link_referred_agent_to_parent` requires explicit agent evidence: `profiles.primary_persona='agent'` OR a row in `house_listings.agent_id` / `agent_collections.agent_id` / `agent_earnings.agent_id` / `rent_requests.agent_id`. Never accept the default role or capabilities.
- Never mass-insert into `agent_subagents` from a referral column. Sub-agent links come from real invites, campaign/`become=agent` signups, or admin assignment.
- Bad links are moved to `agent_subagent_link_archive` (staff-read only), never silently deleted; archived rows keep original id, parent, sub-agent, source, status, created_at and reason.
- Cleanup incident tag: `SUBAGENT-REFERRAL-BACKFILL-2026-08-02` (6,283 deleted + 45,811 archived; 509 genuine links retained).
