# Reversed collections: full surface audit

**As at 2026-09-16, after the final sweep (`20260916240000`).**

> **DATABASE SIDE COMPLETE.** 72 functions now exclude reversed collections and
> **zero money readers remain**. The per-function backlog listed further down has
> been worked through; the EDGE FUNCTION and FRONTEND sections below are now the
> whole of the remaining work.

Once `20260916180000` marks the 1,210 duplicate collections `reversed_at`, any
surface that does not exclude reversed rows keeps reporting them as money
collected. This is the complete inventory of what does and does not.

## The rule (from batch 1, `20260910190000`) — it is not mechanical

Three distinctions have to be made **by hand on every function**:

- **AMOUNT reads must be filtered** — what was collected.
- **IDENTITY reads must NOT be** — or agent and tenant counts move underneath
  every other figure. `agent_ops_collection_agents` needed *both*: the universe
  left unfiltered so counts hold, the activity signal filtered so an agent whose
  only recent collection was reversed stops reading as active.
- **WRITE targets must never be touched.**

> "A blind rewrite across 70+ money-path functions is the same class of change
> that inverted the collection ledger on 2026-09-10."

That warning is why the remaining work below is listed rather than done.

## Good news first: the headline surfaces are correct

Everything a manager actually opens to ask "how much did we collect" already
excludes reversed rows:

| Surface | Status |
| --- | --- |
| `get_agent_ops_overview` | filtered (batch 1) |
| `get_agent_collections_command_center` | filtered (batch 1) |
| `get_agent_collections_coverage` | filtered (batch 1) |
| `agent_ops_report_collected` | filtered (batch 1) |
| `agent_ops_report_team_collections` | filtered (**batch 2**) |
| `get_agent_ops_comprehensive_report` | filtered (**batch 2**) |

**25 reader functions are filtered in total.** After the duplicates are marked,
the collected figure falls from UGX 136,621,549 to the genuine UGX 39,132,545
against a 6,080,933 bill.

## Remaining: 45 functions that SUM collection money and do not filter

These are secondary surfaces — advances, leaderboards, tenant-ops, CEO/COO
snapshots — but each will over-report until swept.

```
agent_advance_activity                      get_agent_products_cumulative
agent_ops_list_subagent_commission_whitelist get_agent_products_services_report (x2)
agent_ops_partial_collection_report (x2)    get_agent_profile_360
agent_ops_report_agent                      get_agent_weekly_champion_team
detect_credit_limit_reconciliation_drift    get_ceo_growth_quality
get_advance_activity_monthly_trend          get_coo_overview_snapshot
get_agent_advance_activity_correlation      get_receivables_forecast
get_agent_collection_league_details         get_service_center_tenant_payments
get_agent_daily_activity_report             get_service_centre_360
get_agent_directory_v2                      get_tenant_missed_dates
get_agent_earned_vouch_in_range             get_tenant_missed_days
get_agent_monitoring_positions              get_tenant_ops_agent_360
get_agent_ops_rent_behaviour (x2)           get_tenant_payment_day_state
get_agent_ops_rent_behaviour_detail         get_tenant_receivable_account_movements
get_tenant_repayment_reliability            ops_tenant_ops_tool_report
ops_agent_ops_weekly_bundle                 ops_tenant_ops_weekly_bundle
ops_list_subagent_tenant_transfers          ops_tenant_products_services_report
ops_tenant_ops_home_range                   ops_tenant_products_services_rows
ops_tenant_ops_tool_counts                  ops_tenant_repayment_forecast
rent_pipeline_tenant_history                smartphone_leaderboard_ranks
snapshot_agent_daily_eligibility
```

**Suggested batch 3**, by how visible a wrong number is:
`get_coo_overview_snapshot`, `get_ceo_growth_quality`, `agent_ops_report_agent`,
`get_agent_collection_league_details` (drives incentives, so a wrong figure pays
the wrong person), `get_agent_daily_activity_report`.

Those five alone carry **17 call sites**, and they are not uniform — e.g.
`get_coo_overview_snapshot` lines 46 and 52 are `SELECT DISTINCT tenant_id` /
`agent_id` universes that must stay unfiltered, while 85, 99 and 114 are amount
reads that must be filtered. `get_agent_daily_activity_report` is the same shape
at lines 55 and 68. Budget the review, not just the edit.

### 16 functions that read but only count / identity

Lower priority, and **some must deliberately stay unfiltered**. Check each
against the rule before touching:

```
agent_daily_collections_overview   get_coo_transaction_kpis
agent_ops_dormant_agents_arrears   get_cto_daily_report
agent_ops_tenants_owing            get_tenant_behavior_segments
get_agent_daily_missions           ops_recent_agent_inactivations
get_agent_guarantor_float_preview  reconcile_agent_team_daily_stats
get_agent_operational_population   refresh_tenant_idle_states
get_agent_ops_criteria_users       search_tenant_behavior
get_agent_tenants_overview
```

### 12 other reads, and 5 writers

Writers are correct as-is — there is nothing to filter on a write:
`agent_allocate_tenant_payment`, `agent_allocate_tenant_payment_internal`,
`confirm_field_collection`, `process_verified_field_deposit`,
`settle_tenant_rent_from_deposit`.

## Edge functions — 14 touch `agent_collections`, none audited

None has been checked against the rule. Ordered by likely money impact:

| Function | refs | Note |
| --- | ---: | --- |
| `weekly-agent-ops-report` | 10 | highest exposure — a weekly figure sent out |
| `weekly-tenant-ops-report` | 6 | |
| `agent-daily-performance-report` | 3 | per-agent daily numbers |
| `send-collection-sms` | 3 | messages a tenant/agent reads |
| `send-system-context` | 3 | |
| `agent-ops-daily-report` | 2 | |
| `notify-agent-collection-lapse` | 2 | activity signal, may be identity-only |
| `admin-float-to-withdrawable` | 1 | money path — review carefully |
| `submit-offline-collection` | 1 | writer; passes `p_client_ref = draft_id` |
| `gmail-poll-transactions`, `tenant-products-services-report`, `export-database`, `weekly-database-backup`, `refresh-tenant-idle-states` | 1 each | mostly export/ingest |

Remember edge functions are **not deployed on push** — `deploy-edge-function.yml`
is manual-only, so a fix here does not ship until someone runs it.

## Frontend — 20+ components read `agent_collections` directly

`AgentCollectionsDrilldownDialog`, `AgentDailyOpsCard`, `AgentPerformanceReport`,
`AgentPerformanceTiers`, `AgentAllocationReport`, `AgentProfile360Sheet`,
`AgentDetailDialog`, `AgentCashReconciliation` (CFO), `AgentCollectionsOverview`
(COO), `FinancialMetricsCards`, `FinancialReportsPanel`, `PaymentModeAnalytics`,
`useCOOReportData`, `AgentOpsOverview`, `FloatTransactionHistory`,
`TenantProfileView`, `AgentVisitPaymentWizard`, `AgentAdvanceRequestForm`,
`AgentDailyOverviewReportButton`, and others.

A direct `.from('agent_collections')` read bypasses every RPC fix above, so
these need the same triage — and per the repo's division of labour, the JSX is
Gemini's, the query is not.

## Also still open

- **`get_agent_products_services_report`** has a second, independent problem:
  its `expected_cumulative` / `daily_receivable` basis is not the pinned bill,
  so its coverage percentage was never comparable to the Command Center's.
  Fix both together or the number stays wrong either way.
- **Pre-existing negative raw float.** Aggregate raw float across the 38
  affected agents was **-3,066,884 before this incident began**. The displayed
  balance is `GREATEST(0, raw)`, so the clamp hides it. Unrelated to the
  duplicates, and worth its own investigation.

---

# Addendum, 2026-09-28: the sweep never reached the plan balance

Everything above is about `agent_collections` — a **row** that can be filtered.
`rent_requests.amount_repaid` is a **column**, and no amount of filtering in a
reader can correct it. That is why a Service Centre "Collection rankings" board
still looks wrong months after 72 functions were fixed: it never read
`agent_collections` in the first place.

## What the rankings board actually reads

`SubAgentRankingsBoard` → `subAgentRankings.ts` → `get_agent_service_center`.
Its `collected` figure is `Σ rent_requests.amount_repaid` over the sub-agent's
collectible plans — **lifetime**, and rendered next to a *per-day* tile with no
period label on either. Verified to the shilling against production: the board
row reading `UGX 17,353,050` is exactly that sum.

## Finding 1 — reversed money is inside 25 plan balances

`20260916180000` recorded that the duplicates were kept out of the tenant
balances, on the evidence that *"zero plans are credited beyond their own
total"*. **That test was too weak.** Staying under `total_repayment` is not the
same as not being credited.

| | plans | UGX |
| --- | ---: | ---: |
| `amount_repaid` = live + reversed, **to the shilling** | 25 | **8,180,000** |
| widened to "above live collections, and has reversals" | 57 | 19,090,568 |

Every reversal behind the 25 is dated **2026-09-16**, and none of them appears
in the `repayment_restored_after_guard_drop` audit set — so this is the
duplicate sweep, not the restore.

The clearest case: one plan carries **59 reversed rows worth 2,537,000** against
**64,000** of real collections, and reads 2,601,000 of a 2,680,000 plan. A
tenant shown 97% repaid who has actually paid 64,000.

The 57/19.1m figure is an **upper bound, not a diagnosis** — deposit settlement
and tenant self-payment also write `amount_repaid` without leaving an
`agent_collections` row. The 8,180,000 exact-match subset is the certain part.

## Finding 2 — 39% of all plan balance has no cash record behind it

`amount_repaid` has **fifteen writers**, including administrative completion and
ops balance edits:

```
admin_void_unverified_collection      agent_allocate_tenant_payment_internal
agent_reverse_tenant_allocation       agent_set_rent_payment_status
agent_unallocate_tenant_payment       auto_close_fully_repaid_rents
cfo_decide_agent_unallocation         ops_edit_tenant_balance
ops_record_payment_edit               ops_sync_rent_request_status_to_balance
record_rent_request_repayment         replace_tenant_at_property
settle_tenant_rent_from_deposit       tenant_ops_correct_rent_request
trigger_agent_liability_for_unpaid_rents
```

Platform-wide, crediting both cash sources in full:

| | UGX |
| --- | ---: |
| `Σ rent_requests.amount_repaid` | 658,861,483 |
| `Σ agent_collections` (live) | 374,136,222 |
| `Σ repayments` | 119,681,158 |
| **unbacked by either** | **≈ 257,378,699** across 215 plans |

Worst single pattern: four plans on one agent each read ~5,340,000 repaid
against 130,000–940,000 of collections, several `completed`, with nothing in
`audit_logs` after the funding date.

Some of this is legitimate — neither table records every settlement path — so
the number is a question, not an accusation. It is **not** a fault in the
collection path, which is why it ships as `info`.

## Shipped

`20260928120000` adds both to `agent_collections_monitor` (CTO → Monitor →
Agent Collections), each with a plan-level drill-down:

- `plan_balance_holds_reversed` — **high**, 57 plans / 19,090,568
- `plan_balance_unbacked` — **info**, window-scoped, 73 plans / 71,625,995 at 14d

## Still open

1. **Do the 25 tenants keep the 8,180,000?** Correcting the balances raises what
   those tenants owe. That is an outward-facing decision, not an engineering
   one, and `20260916180000` deliberately chose not to touch tenant balances —
   but it chose that on a premise this addendum disproves.
2. **Should the rankings board rank on collections rather than the balance?** It
   is labelled "Collected" and drives incentives. Switching the basis reorders
   the table materially — e.g. 13,350,179 → 7,445,779 for one agent — so it is a
   product call, not a bug fix.

> **Finding 2 has been investigated** — see
> [`plan-balance-unbacked-investigation.md`](./plan-balance-unbacked-investigation.md).
> Short version: 78% of it was typed in through `tenant_ops_correct_rent_request`
> (261 edits, +201,096,194), 45 of those edits were made by the plan's own agent
> (+79,980,321), and the 22 September Book of Accounts correction then restated
> 428,230,339 of receivable to agree with the column. A third path — the manager
> RLS policy on `rent_requests` — leaves no audit row at all.
