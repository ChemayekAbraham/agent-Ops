---
name: Weekly Agent Listing Campaign (Weekly Listing Mission)
description: Home-tab agent campaign to recruit sub-agents who list verified houses, with UGX 70,000 weekly completion bonus
type: feature
---
Home-tab campaign motivating main agents to invite + activate sub-agents who list verified empty houses.

**Targets (per Monday–Sunday week, `date_trunc('week', now())`):** 20 sub-agents invited, 20 activated (a sub-agent is "activated" once it has ≥3 verified houses this week), 60 verified houses total.

**Earnings:** UGX 3,000 per verified house (the existing recruiter-override commission, already paid live) + UGX 70,000 one-time completion bonus. Total potential = 60×3,000 + 70,000 = **UGX 250,000**. Only the unearned 70k bonus expires when the week closes; earned house commissions persist.

**Counting (all restricted to current campaign week):** invitees = union of `agent_subagents` (parent=agent, status≠rejected), `referrals` (referrer=agent), `profiles.referrer_id`=agent — all created this week. Verified houses = `house_listings` by invitees where `verified=true AND status<>'rejected' AND is_hidden=false` created this week.

**Backend:**
- Table `agent_listing_campaign_bonuses` (unique `agent_id, week_start`) records the 70k award + snapshot counts; RLS: agent sees own, agent-ops staff see all; no client insert.
- `get_agent_listing_campaign(p_agent_id)` (STABLE SECURITY DEFINER) → jsonb progress for current week.
- `award_agent_listing_campaign_bonus(p_agent_id)` (SECURITY DEFINER) → idempotent; posts 70k via `create_ledger_transaction` (marketing_expense platform leg → agent_commission wallet leg, recipient_type user), inserts into `agent_incentive_bonuses` + `agent_mission_completions` (mission_key `weekly_listing_mission`) + notification.

**Frontend:**
- `useAgentListingCampaign(agentId)` — fetches progress; auto-calls award RPC once when `bonus_eligible && bonus_earned===0`, then refetches.
- `WeeklyListingMissionCard` in `AgentDashboard` home tab (hidden for merchant agents), placed after `AgentPriorityGrid`. Dynamic message + CTA states: Invite Agents → invite sub-agent flow; Help Agents List Houses / View My Team → sub-agents sheet; View Earnings → money tab.
