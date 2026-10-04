---
name: Tenant Ops Inbox + Segments + Behavior
description: 3-tab ops dashboard pattern (Inbox/Segments/Search + Behavior drawer) built first for Tenant Ops, intended to be replicated to Agent Ops and Landlord Ops
type: feature
---
Tables: `ops_inbox_state`, `ops_saved_segments`, `ops_inbox_events` (realtime-published).
RPCs (SECURITY DEFINER, search_path=public, gated by `is_tenant_ops_staff` = manager/operations/coo/super_admin):
- `ops_tenant_inbox(bucket, limit, cursor)` — buckets: critical/at_risk/watch/new/snoozed
- `ops_query_tenants(segment_id, cursor, limit)` — keyset paged, reads JSON filter
- `ops_tenant_behavior(tenant_id)` — single JSON payload for the right-side drawer

Severity (current rules):
- critical: outstanding>0 AND days_no_progress>=7
- at_risk:  outstanding>0 AND days_no_progress>=3
- watch:    trust_score<400
- new:      profile.created_at within 7d AND not verified
- snoozed:  ops_inbox_state.snoozed_until>now

Frontend: `src/components/executive/TenantOpsHub.tsx` toggles between `TenantOpsDashboard` (Classic) and `TenantOpsDashboardV2`. Primitives live under `src/components/ops/`: `InboxBucketList`, `SegmentBrowser`, `TenantOpsSearch`, `BehaviorDrawer`. Hooks: `useOpsInbox`, `useOpsSegment`, `useTenantBehavior`. Only one realtime channel per ops session: `ops:inbox:{uid}` listens to `ops_inbox_events` inserts.

Replication: same shell + drawer reused for Agent Ops and Landlord Ops by writing scope='agent'/'landlord' segments and analogous inbox/behavior RPCs.
