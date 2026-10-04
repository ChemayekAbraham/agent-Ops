---
name: Proxy Weekend Badge
description: Proxy Partner Funds card shows a "Weekend" badge next to the partner name when the underlying proxy_agent_assignments row was created on a Saturday or Sunday
type: feature
---
Derivation is client-side in `ProxyPartnerFunds.tsx`:
- `loadProxyFunds` selects `created_at` alongside `beneficiary_id, is_managed_account` from `proxy_agent_assignments`.
- A `weekendPartnerIds: Set<string>` is built from rows whose `new Date(created_at).getDay()` is 0 (Sun) or 6 (Sat).
- The card header renders an amber `Weekend` `<Badge>` next to `partner.partnerName` when `weekendPartnerIds.has(partner.partnerId)`.

No schema change. If ops later need an explicit weekend flag independent of creation timestamp, promote this to an `is_weekend` column on `proxy_agent_assignments` and toggle the source of truth in the same file.