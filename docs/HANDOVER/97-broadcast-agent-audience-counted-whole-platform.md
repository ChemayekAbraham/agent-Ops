# 97 — Broadcast SMS "Agents" audience was 58,755 users, not ~233 agents; fixed in code, not yet deployed

**Fixed in code 2026-09-21, deploy status unconfirmed — same doc 79 GitHub Actions blocker.**
Before touching `broadcast-audience-sms`/`fetchRoleUserPhones` again, or trusting the Agents
recipient count on the Broadcast SMS screen.

## What was reported

Follows directly from doc 96 (TID-backed float rule). Josh asked to send the new-rule notice to
"all rent collection agents." Checking the actual Broadcast SMS screen first (screenshot): with
"Agents" selected, it showed **"Send to 57,527 recipients."**

## Root cause

`fetchRoleUserPhones(admin, 'agent')` queried `user_roles WHERE role='agent'` directly and used
every matching `user_id`. In this system almost every account carries all four roles at once —
`{tenant, agent, landlord, supporter}` — confirmed by spot-checking dozens of profiles throughout
this session's investigation, all showing the same role array. So "Agents" in the broadcast picker
was, in practice, "everyone," not real field/referral agents. Verified live:

| Definition | Count |
|---|---:|
| Raw `user_roles WHERE role='agent'` (what the picker showed) | 58,755 |
| Ever assigned/linked to a rent request as agent, or ever collected | **233** |
| Ever actually logged a rent collection | 85 |
| Active in the last 30 days | 74 |

Sending to 57,527 would have hit almost the entire tenant/landlord/supporter base too, at real
per-segment SMS cost, for a notice that only applies to ~233 people.

## The fix

`fetchRoleUserPhones` now special-cases `role === 'agent'`: instead of the raw role-table query, it
calls `agent_ops_strict_agent_ids()` — the same canonical "is this actually an agent" definition
`get_agent_ops_overview` and `get_agent_ops_top_agents` already use (anyone who's ever collected
rent via `agent_collections`, or been `assigned_agent_id`/`agent_id` on a `rent_requests` row,
excluding self-requests). Reused deliberately rather than inventing a second definition that could
drift from the first. `tenant` and `landlord` audiences untouched — not investigated this pass, no
evidence of the same problem, out of scope for what was asked.

## Deploy status — NOT confirmed live

Same blocker as doc 79: GitHub Actions edge-function deploy has no `SUPABASE_ACCESS_TOKEN` secret
configured for this repo and has never once succeeded. This is a **code-only** change until
someone with deploy access ships it. **Do not assume the Broadcast SMS screen shows the corrected
233 until this is verified live** — reload the screen with "Agents" selected and confirm the
recipient count before trusting it or sending anything through it.

## What was deliberately NOT done

- Did not send the TID-backed-float notice myself — no live authenticated staff session available
  from this tool (the function requires a real user JWT + role check;
  direct DB access does not substitute for that), and the audience count was wrong at the time
  anyway. Gave Josh the exact message text and the corrected recipient definition instead.
- Did not touch `AudienceSMSBroadcast.tsx` or `BroadcastStatusPanel.tsx` (UI) — this was a
  data-correctness fix in the edge function, Gemini's lane is the screen itself if it needs a
  "why is this number different now" tooltip or similar.
