# 104 — New RPC: `get_my_agent_collections_today()`, a self-scoped expected-vs-collected

**Built and applied live 2026-09-22.** Before touching `get_my_agent_collections_today`,
`get_agent_collections_coverage`, or assuming an agent can call the CFO Command Center's
coverage RPC for their own numbers — they can't, it's role-gated.

## What was asked

Building the native Android app's agent dashboard feature-by-feature (see the separate
`welilereceipts-mobile` repo). Feature 2, after the wallet summary: today's expected vs
collected for the signed-in agent.

## Why a new RPC instead of reusing an existing one

`get_agent_collections_coverage(p_start, p_end)` already computes this correctly — pinned
bill vs receipt book, on-schedule/arrears split, reversed rows excluded — but requires
`has_role(auth.uid(), ...)` to be one of manager/super_admin/ceo/coo/cfo/operations/agent_ops.
An ordinary field agent has none of those roles, so calling it for their own dashboard raises
`not authorized`. `agent_daily_collections_overview(p_from, p_to, p_forecast)` — the other
candidate — is also CFO/ops-report-gated (`assert_agent_collections_report_access()`) **and**
computes `expected` as `daily_repayment * days` read live, not from the pinned
`agent_expected_day_plans` bill — exactly the naive-division trap the
`welile-expected-vs-collected` skill warns about. Neither is safe to expose to a self-service
agent app.

`get_my_agent_collections_today()` mirrors `get_agent_collections_coverage`'s corrected logic
(same bill/cash CTEs, same reversed-row exclusion, same on-schedule/arrears/unattributed split),
scoped to `auth.uid()` and "today" (`Africa/Kampala`) instead of an admin-supplied date range
and agent list. `SECURITY DEFINER`, granted to `authenticated`, returns
`{day, expected_due, collected_total, collected_on_schedule, collected_arrears,
collected_unattributed, coverage_pct, coverage_basis, generated_at}`.

## Verified live

```sql
select set_config('request.jwt.claim.sub', '<a real agent id>', true);
select public.get_my_agent_collections_today();
```

returned real, sane figures for an active agent (expected_due 393,300; collected_on_schedule
1,700; coverage_pct 0.4 — early in the day, most tenants hadn't paid yet). Confirmed the
`auth.uid() is null` guard fires `not authorized` when called with no JWT context.

## What this deliberately does not solve

The attribution mismatch flagged in the skill — `agent_expected_day_plans.agent_id` is plain
`rent_requests.agent_id`, while some reporting paths credit collections to
`COALESCE(assigned_agent_id, agent_id)` — is not addressed here. This function filters
`agent_collections` by `agent_id` directly, the same basis `get_agent_collections_coverage`'s
own per-agent split already uses, so it's consistent with the existing reviewed logic, not a
new inconsistency. A reassigned plan can still show its bill and its cash on different agents;
that's an open issue, not something this migration introduces or fixes.
