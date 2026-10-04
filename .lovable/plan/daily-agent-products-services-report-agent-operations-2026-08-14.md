# Daily Agent Products & Services Report (Agent Operations)

A new read-only section inside the Agent Operations Dashboard that summarises one day of agent growth, collections, advances, service centres, product repayments and per-agent float — with a date picker, KPI cards, charts, drill-down tables and a one-click PDF download. Mirrors the existing Tenant Products & Services Report so look, feel and PDF branding stay consistent.

## What the Operations Manager sees

Header: date selector (single day, defaults to today, EAT), Refresh, and **Generate Daily Report (PDF)** which downloads immediately.

KPI cards (auto-calculated, no hard-coded values):
- New agents today, total agents, % increase vs. existing base
- Rent: collected today, outstanding, daily receivable due, average days outstanding
- Advances: submitted, approved, rejected, amount issued, amount deducted, outstanding receivable
- Service centres: active, new today, % growth, progress vs. monthly target
- Bikes: issued, total value, daily receivable, paid, outstanding
- Smartphones: issued, total value, paid, outstanding

Charts (compact, same style as existing panels):
- Collections vs. daily receivable (last 14 days)
- Advances issued vs. deducted (last 14 days)
- Service centres added per day vs. monthly target pace

Tables, each paginated 10–15 per page with tap-to-open detail drawer:
1. Rent receivables by agent (collected, outstanding, days outstanding)
2. Advances (agent, status, issued, deducted, outstanding)
3. Service centres (agent, location, status, date added)
4. Bikes — per person: value, paid, outstanding, repayment position/rate
5. Smartphones — per person: same columns
6. Individual agent performance: float received, paid out, closing float, transactions, collections

Filters: date, agent (search), location/district, product (bike / smartphone / merchandise), repayment status (on track / behind / cleared).

Drill-down: tapping any agent row opens a drawer with that agent's collections, advances and product repayment lines for the selected day.

## Technical approach

- **One RPC, one round trip.** New `public.get_agent_products_services_report(p_date date)` (SECURITY DEFINER, `SET search_path = public`, restricted to agent-ops/manager/COO/CEO/super_admin via `has_role`) returns a single JSON payload: `kpis`, `trend` (14-day series), and arrays `rent_rows`, `advance_rows`, `service_centre_rows`, `bike_rows`, `phone_rows`, `agent_float_rows`. All aggregation server-side — no N+1, no client-side pagination over unbounded data.
- **Real sources:** agents from `profiles` + `user_roles`; rent from `rent_requests` / `agent_collections` and `v_agent_daily_eligibility` for the daily receivable; advances from `agent_advance_requests` + `agent_advances` + `agent_advance_ledger`; service centres from `service_centre_setups`; bikes and smartphones from `merchandise_sales` filtered on `item_name` ('Welile Spiro Bike', 'Welile Smartphone') with `amount_paid` / `amount_outstanding` and `merchandise_recovery_plans` for repayment position; per-agent float from `v_user_wallet_strict` plus float-scope `general_ledger` legs for the day.
- **Service-centre monthly target:** no target table exists today, so one small config table `agent_ops_service_centre_targets` (month, target_count) is added with GRANTs + RLS (agent-ops/manager write, ops roles read) and an inline editor in the report header. Target achievement = new centres this month ÷ target.
- **New files:** `src/components/executive/agent-ops/AgentProductsServicesReport.tsx`, `src/hooks/useAgentProductsServicesReport.ts`, `src/lib/agentProductsServicesPdf.ts` (jsPDF landscape, same branded header/footer as `generateTenantProductsServicesPdf.ts`).
- **Wiring:** one new case (`agent-products-report`) in `src/components/executive/AgentOpsDashboard.tsx` and an entry in its Reports section list. No existing panel, workflow or business logic is changed; the report is strictly read-only apart from the target setting.
- Amounts formatted with `formatUGX`; all day boundaries computed in EAT.

## Out of scope
No changes to advance approval, collection, merchandise or float workflows; no scheduled email (this is on-demand only).
