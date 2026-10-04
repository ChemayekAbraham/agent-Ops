---
name: Sub-agent registration reward requires 3 house listings
description: Recruiting agent earns the subagent_registration bonus only after the invited sub-agent lists >= 3 valid houses
type: feature
---
A recruiting agent earns the `subagent_registration` event bonus (credited via `credit_agent_event_bonus`, **UGX 10,000**, matching the UI `EVENT_BONUSES`) ONLY once the invited/verified sub-agent has at least 3 **VERIFIED** house_listings (`verified = true AND status <> 'rejected'`). Submitted-but-unverified houses do NOT count (fixed 2026-07-10 #2 — previously counted any non-rejected listing, so the parent was paid the instant 3 houses were submitted, before verification). NOTE: both `credit_agent_event_bonus` overloads must keep this at 10,000 — it was once silently lowered to 3,000, which broke payouts and mismatched the UI (fixed 2026-07-10, plus a one-time backfill of missed eligible parents).

Enforcement (DB):
- `subagent_listing_count(uuid)` — counts a sub-agent's **verified** (`verified = true`), non-rejected `house_listings`.
- `try_award_subagent_registration_bonus(uuid)` — gate: requires count >= 3, then pays each verified `agent_subagents.parent_agent_id` for that sub_agent. Idempotent via `credit_agent_event_bonus` (source_id = sub_agent_id).
- Trigger `award_subagent_registration_bonus()` on `agent_subagents` (verify) now calls the gated helper instead of paying immediately.
- Trigger `trg_award_subagent_bonus_on_listing` on `house_listings` (AFTER INSERT/UPDATE OF status, verified) awards retroactively when a verified sub-agent crosses the 3rd **verified** listing.
- The verify trigger is attached as `trg_award_subagent_commission` (its function is `award_subagent_registration_bonus`).
