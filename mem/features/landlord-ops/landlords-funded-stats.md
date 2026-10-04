---
name: Landlords Funded statistics + export
description: ops_landlord_funded_stats RPC and the Landlords Funded PDF pack (KPI comparisons, daily trend + district charts, per district/agent/service centre tables, funding register) in the Landlord Ops Landlords tab.
type: feature
---

# Landlords Funded (Landlord Ops → Landlords tab)

Definition: a landlord is FUNDED on the date company money was committed to
their property — `rent_requests.funded_at` inside the selected window, joined on
`rent_requests.landlord_id`. Not `agent_landlord_payouts` (empty in production).

## RPC `public.ops_landlord_funded_stats(p_date_from, p_date_to, p_search)`
SECURITY DEFINER, gated on `is_ops_role()` OR cfo / cto / landlord_ops.
Returns one jsonb: `range`, `summary`, `previous` (immediately preceding window
of EQUAL length — every figure carries a like-for-like comparison),
`by_district`, `by_agent`, `by_service_centre`, `daily`, `rows` (cap 5000).

District fallback chain (landlords.district is ~3% populated):
`landlords.district → tenant profiles.district → house_listings.district → 'Unspecified'`.
Service centre = the verified parent agent from `agent_subagents`, else the agent
themself.

## UI
- 7th stat tile `LANDLORDS FUNDED` in the Landlords tab, driven by
  `useLandlordFundedStats` and the tab's existing search + date range.
- `Funded Report` button → `generateLandlordFundedReportPdf` (landscape PDF:
  8 KPI tiles with deltas, quality strip, daily column+line chart, top-12
  district bar chart, 3 breakdown tables, funding register). Charts are drawn
  with jsPDF primitives — no chart library, no images.
