---
name: Proxy Agent Command Center
description: /agent/proxy-agents dashboard — partner attribution sources, promissory-note linkage, 2%/1%/note-reward commission breakdown, sub-proxy team, invite logging
type: feature
---
Route `/agent/proxy-agents` (`src/pages/agent/ProxyAgentCommandCenter.tsx`, hooks in `src/hooks/useProxyAgentCommandCenter.ts`).

Server aggregates (no N+1; all SECURITY DEFINER + self-gated by `proxy_cc_resolve_agent`):
- `get_proxy_agent_command_center(p_agent_id)` — headline KPIs, commission breakdown, pending commission, targets, invites, team size.
- `list_proxy_agent_partners(...)` / `list_proxy_agent_promissory_notes(...)` — paginated + search + sort, return `{total, rows}`.
- `get_proxy_agent_team(p_agent_id)` — sub-proxy network (from `partner_lead_assignments` where `lead_user_id = agent`).
- `log_proxy_partner_invite(channel,name,phone)` — logs a share, returns `/funder-onboarding?ref=<agent>&pi=<code>`.
- `set_proxy_agent_target(target)`.

Partner attribution (`proxy_agent_partner_rows`) unions six sources: `supporter_invites.created_by`, approved active `proxy_agent_assignments`, `profiles.referrer_id` (+supporter role), `investor_portfolios.agent_id`, `promissory_notes.agent_id`, `proxy_partner_invites.signed_up_user_id`. "Came in" = ≥1 portfolio; "Returning" = ≥2 portfolios.

Commission breakdown: 2% = `proxy_investment_commission` + `agent_investment_commission`; 1% = `partner_commission`; note rewards = `agent_commission` with `source_table='promissory_notes'`. Pending commission = pending notes × `partner_note_rate('agent')`.

New tables: `proxy_partner_invites` (invite shares + conversion), `proxy_agent_targets` (monthly partner target, default 10).
Linkage triggers: `link_promissory_note_partner` (BEFORE INSERT on promissory_notes, phone match) and `link_proxy_records_on_profile` (AFTER INSERT/UPDATE of phone/referrer_id on profiles) attach notes + claim invites when a partner registers.

Money must be shown in full via `formatDynamic` — never compact/clamped (no "4.50M").
