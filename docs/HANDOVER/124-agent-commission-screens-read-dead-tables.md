# 124 — Agent commission screens showed zero: they read tables nothing writes any more

**Fixed 2026-09-24 (frontend data-fetch + one read-only RPC, migration
`20260924160000_get_my_subagent_rent_overrides.sql`, applied live). Before adding any agent-facing
earnings/commission figure: read it from `general_ledger`, never from `agent_earnings` or
`commission_accrual_ledger`.**

## What was reported

Agent **Oscar Arnold** (profile name "OACAR ARNOLD", `ebd985fb-dc19-43f8-b5f4-4e8cf1150fd4`),
2026-09-24: "I am not getting any commission, it's showing zero, even after allocation … not
getting the 2%, seeing 0000000000 … 100k I was supporting a tenant on partners dashboard then it
also disappeared." Later: "my commission is still not coming after allocation."

## What was found

**The money was always paid.** His ledger on 09-24:
- 11:01 EAT: allocated UGX 25,000 → `agent_commission_earned` UGX 2,500 (10%);
- 12:02 EAT: allocated UGX 15,000 → UGX 1,500, in the same second;
- 2% recruiter overrides on sub-agent collections every day: 89 credits, UGX 23,854 lifetime.

System-wide, commission credits kept pace with collections every hour of the day, so this is not
connected to docs 117 (repaying gate) or `ede6468e30` (proxy portfolio commission gate).

**Why he saw zero:** four agent screens summed tables that are no longer written:

| Screen | Read | Last write |
|---|---|---|
| `SubAgentsList.tsx` (sub-agent 2% earnings) | `agent_earnings` subagent_commission + `commission_accrual_ledger` role `recruiter` | April / role no longer written (table now only gets `event_bonus`) |
| `AgentPartnerDashboardSheet.tsx` (commission total + history) | `agent_earnings` | 2026-07-20 (rent commission since 2026-04-03) |
| `EarningsForecastCard.tsx` (earned-to-date) | `agent_earnings` | same |
| `EarningsRankSystemSheet.tsx` (total earnings) | `agent_earnings` | same |

The 10% and 2% are posted straight to `general_ledger` (wallet, cash_in, `source_table =
'agent_collections'`, `source_id` = the rent plan). `useAgentEarnings` (the main earnings view) had
already moved to the ledger and was correct, except that it didn't map `partner_commission` (proxy
portfolio commissions: 500 credits in 30 days), so those were invisible on the agent side.

A second trap: the sub-agent list attributed each override to a sub-agent through the sub-agents'
`rent_requests`, but **rent_requests RLS lets a parent see only a few of their sub-agents' plans**.
Oscar can see 4 of 30, while his overrides come from 12 plans. A client-side join would still
attribute almost nothing.

**The "disappeared" 100k** is unrelated. It was a UGX 100,000 pending partner portfolio
(`WPF-9837`, 09-18) funded from operational float. Partner Ops (PIUS LUBEGA SSENKALI) rejected it
09-24 11:24 EAT ("no rent plan to support"). A pending portfolio is only a hold
(`funder_pending_hold`), never a ledger debit, so rejecting it freed the float. He re-created it
at 11:32, so UGX 100,000 is held again pending review.

## What was done

- `src/lib/agentLedgerEarnings.ts`:
  - `fetchAgentLedgerEarnings(agentId, {from,to,types})` pages through the agent's own wallet
    cash_in earning categories, uses the existing customer-wallet visibility filters, and classifies
    each row as `commission` (own collection), `subagent_commission` (override), `investment_commission`
    (partner/portfolio) or `bonus`.
  - `fetchMySubagentRentOverrides` calls the new RPC.
- RPC `get_my_subagent_rent_overrides(p_from, p_to)`: SECURITY DEFINER, read-only. It returns the
  caller's **own** override credits grouped by **their own direct** sub-agent. EXECUTE is granted to
  authenticated only. It isn't in the generated `types.ts` (to avoid the schema-fingerprint guard
  and a clash with Lovable's regeneration), so the helper calls it through a typed cast.
- The four screens' data queries now use these helpers. Markup is untouched. The sub-agent list and
  rank sheet fall back to empty on error, as the old queries effectively did.
- `useAgentEarnings`: added `partner_commission → investment_commission`.

Verified as Oscar (role `authenticated`, his JWT sub, rolled back): 605 rent commissions /
UGX 3,931,350 visible (today UGX 4,000), and the RPC returns UGX 23,854.36 across his 4 sub-agents
(today UGX 660). The scoped `tsc` is clean, lint shows no new findings, and `guard:all` passes.

## Not done

- Staff screens still read `agent_earnings`: `AgentAdvanceEvaluationDialog`, `coo/AgentActivityChart`,
  `coo/AgentDetailDrawer`, `executive/AgentDetailDialog`, `AgentLifecyclePipeline`, `AgentOpsDashboard`.
  They show stale (pre-July) earnings for every agent. The same helper pattern applies, but staff
  reading another agent's ledger goes through the manager/executive RLS policies, so check each role
  before switching.
- The `agent_earnings` table itself should be retired or backfilled, so nothing new is built on it.
