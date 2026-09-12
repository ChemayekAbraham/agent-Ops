---
name: Payment collections projection (Tenant Ops)
description: get_payment_collections_projection RPC + Collections Forecast tab in Tenant Products & Services — history-based trend only, no run-off, honest confidence caps
type: feature
---

`get_payment_collections_projection(p_granularity day|week|month|quarter, p_periods)` (SECURITY DEFINER, STABLE, gated by `ops_tps_report_authorized()`, anon revoked) projects future rent-payment collections from `v_receivables_collection_history` ONLY (the shared collections definition — never re-declare the union). Model: 28-day median daily level + OLS weekly trend damped by 1/(1+t/90) + day-of-week factors when >=60 observed days. No run-off of the receivables book and no manual growth assumptions (user chose trend-only).

Quality: end-of-period <= 25% of history span → high (0.85), <= span → medium (0.6), beyond → low (0.35); <21 observed days forces low. Bands widen with horizon (0.15 + 0.6*offset/span, capped 0.8).

Frontend: `src/hooks/usePaymentCollectionsProjection.ts`, `src/components/executive/tenant-ops/CollectionsProjectionPanel.tsx`, PDF `src/lib/collectionsProjectionPdf.ts`; mounted as "Collections Forecast" tab in `TenantProductsServicesReport.tsx` (lazy). Read-only — nothing is stored. Migrations: drizzle 0009 (create), 0010 (fix nested-aggregate DOW factors).
