# Proxy Agent Performance Value (PV)

## What I found (verified against the live database)

**Where the two screens live**
- Individual dashboard: `/agent/proxy-agents` → `src/pages/agent/ProxyAgentCommandCenter.tsx`, data via `src/hooks/useProxyAgentCommandCenter.ts` (single aggregate RPC `get_proxy_agent_command_center`).
- Management: Partner Ops → Proxy Agents → `ProxyAgentDirectory.tsx` + `ProxyAgentDetailPanel.tsx`, data via `proxyAgentDirectory.ts` (`partner_ops_proxy_agent_directory`, `partner_ops_proxy_agent_detail`).

**Which existing data provides each metric**

| PV component | Source of truth | Confirmed / valid filter |
|---|---|---|
| Verified commitments × 1,500 | `promissory_notes` (agent_id, status, approved_at) | `status = 'activated'`, dated by `approved_at`; today 194 activated / 58 pending |
| New investments × 2% | `promissory_commission_events` where `kind='portfolio_creation'` | `status='paid'`, `base_amount` = portfolio principal, `rate=0.02` |
| Partner top-ups × 1% | `promissory_commission_events` where `kind='portfolio_topup'` | `status='paid'`, `base_amount` = principal increase, `rate=0.01` |

- **Proxy agent → partner link:** `promissory_notes.agent_id` → `partner_user_id` (phone/email match trigger `link_promissory_note_partner`), plus the wider union already in `proxy_agent_partner_rows(agent)`.
- **New investment vs top-up:** already distinguished by the `kind` column on `promissory_commission_events` (`portfolio_creation` vs `portfolio_topup`), written only when the portfolio/top-up is confirmed. Rejected, cancelled and skipped events carry a non-`paid` status / `skip_reason` and are excluded.
- **1,500 rate** is already the live `partner_note_rate('agent')` value, and 2% / 1% are already the live rows in `promissory_commission_rates` — PV will read these rates, not hardcode them.

**Ambiguity resolved:** one verified commitment = one activated promissory note (your choice).

**Schema changes actually required:** only one small table for the PV target — no target of this kind exists. `proxy_agent_targets` in the live database has just `(agent_id, monthly_partner_target)`. Note: the existing `partner_ops_set_proxy_agent_target` function references `metric_key/period_month/target_value` columns that **do not exist** live, so that Partner Ops target panel is already broken; I will leave it alone (out of scope) and not build PV on top of it.

## Implementation

### 1. Database (one migration)

- `proxy_pv_targets` — one row per month: `period_month`, `monthly_pv_target` (default 2,000,000), `working_days` (default 26), `note`, `set_by`. Grants + RLS: proxy agents/ops can read, Partner Ops/executive can write. Seeded with the current month.
- Helper `proxy_pv_working_days(p_month)` — count of Mon–Fri days, and `proxy_pv_working_days_elapsed(p_month)` for MTD expected PV.
- `get_proxy_agent_pv(p_agent_id, p_month)` — SECURITY DEFINER, self-gated by the existing `proxy_cc_resolve_agent`, returns one JSON payload: today's PV + contributors, MTD actual/expected/%, monthly target/remaining/working days remaining, the three-line breakdown (count/base × rate = PV), and a per-working-day array for the month (date, commitments, new investments, top-ups, daily PV, daily target, %).
- `partner_ops_proxy_agent_pv(p_month, p_search, p_sort, p_dir, p_limit, p_offset)` — SECURITY DEFINER, gated by `is_proxy_directory_viewer`: returns team KPIs + paged per-agent rows (commitments, new investments, top-ups, the three PV components, total PV, MTD expected PV, performance %, status band) in one round trip, no N+1.

Status bands (compared against **expected MTD PV**, uncapped): ≥100% Target achieved, 80–99% Near target, 50–79% Below target, <50% Significantly below.

### 2. Proxy agent dashboard

- New `src/components/agent/ProxyPerformanceSection.tsx` + `useProxyAgentPerformance` hook, mounted as the top "My Performance" block of `ProxyAgentCommandCenter.tsx`:
  - **Today's performance**: `PV / daily target` + % + progress bar, then three contributor tiles (Commitments, New Investments, Partner Top-Ups) each with volume and PV.
  - **Month-to-date**: actual PV, expected by today, performance %, monthly target, remaining, working days remaining, and a factual status line ("Ahead of target", "UGX 120,000 PV needed to catch up", "Excellent — 142% of target").
  - **Monthly progress visual** to UGX 2M that keeps rendering past 100% (segmented bar with 100% marker); shows "Target exceeded" + amount above target.
  - **Performance breakdown** showing the arithmetic (`400 × UGX 1,500 = UGX 600,000 PV`, `UGX 30,000,000 × 2% = UGX 600,000 PV`, …, total).
  - **Daily performance history** for the month: compact rows on mobile, table on desktop.
- Existing commission/earnings cards stay untouched; PV is labelled clearly as a performance score, not payable money.

### 3. Partner Ops → Proxy Agents

- New "Performance" view (`proxy.performance` nav entry under Proxy Agents) rendering `ProxyAgentPerformanceBoard.tsx`:
  - Month picker (any month), search, KPI cards: Total proxy agents, Team MTD PV, Team new investments, Team partner top-ups, Total verified commitments, At/above target, Below target.
  - Sortable performance table (performance %, total PV, new investment, commitments, top-ups, lowest performance %) with status badges and an over-performance indicator.
  - Clicking a row opens a detail view reusing the **same** `ProxyPerformanceSection` component in read-only mode for that agent (identical breakdown + daily history) plus management fields already available from `partner_ops_proxy_agent_detail`.

### 4. Out of scope (as instructed)
No monetary bonus is computed. Percentages are returned as plain uncapped numbers so a future benefits system can consume them.

## Notes
- All money shown in full UGX via the existing `formatDynamic` / `formatUGX` helpers; existing cards, tabs and design tokens reused; no new colour or layout language.
- Reversed/failed/skipped commission events and non-activated notes contribute zero PV; no new attribution logic is invented.
