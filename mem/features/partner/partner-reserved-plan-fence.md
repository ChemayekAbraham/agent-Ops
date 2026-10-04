---
name: Partner-reserved rent plans are fenced from company float
description: Rent plans held/committed/funded by a partner self-managed funding can never be disbursed from company landlord float; DB trigger + psm_reserved_plan_ids queue filter
type: constraint
---
# Partner-reserved plan fence (2026-08-19)

`public.psm_plan_partner_reserved_stage(rent_request_id)` returns
`partner_funded` (rent_requests.self_funding_partner_id set) /
`partner_committed` (line on a `pending_ops_approval` or `active`
`partner_self_commitments`) / `partner_held` (live `partner_self_plan_claims`)
or NULL.

- HARD FENCE: `trg_guard_partner_reserved_float_allocation` on
  `agent_landlord_float_allocations` BEFORE INSERT raises `42501
  PARTNER_RESERVED` for any allocation whose `source <> 'partner_self_funding'`
  on a reserved plan. The CFO/company route (`fund-agent-landlord-float`)
  therefore cannot double-fund a partner plan.
- BADGE (CFO queue): `RentDisbursementQueue` KEEPS reserved rows visible with a
  violet `PARTNER CLAIMED` / `PARTNER FUNDED` badge, checkbox disabled, row
  greyed + tooltip. Never silently hide them there — the CFO must see why the
  plan is not fundable. Use `fetchPartnerReservedStages`.
- SOFT FENCE (UI): `src/lib/partnerReservedPlans.ts`
  (`excludePartnerReservedPlans`) calls `psm_reserved_plan_ids(uuid[])` — ONE
  round trip, IDs only, no partner identity — and is applied in
  `RentDisbursementQueue`, `BatchPayoutProcessor`,
  `ApprovedRequestsFundingWidget`. Add it to any new funding queue.
- After Partner Ops approval the plan is `funded`, so it also falls out of the
  `status='coo_approved'` / `'approved'` queues naturally.
