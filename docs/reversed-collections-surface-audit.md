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
