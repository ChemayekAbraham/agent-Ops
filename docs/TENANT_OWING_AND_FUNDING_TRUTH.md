# Tenant Owing vs Funding Truth

Last updated: 2026-08-17

## The problem

Tenants appeared in the agent's owing / Priority Collections list even though
Welile had never disbursed anything for them and their landlord held no funds.

`rent_requests.total_repayment` and `daily_repayment` are written when the agent
**creates** the request — long before the CFO disburses. Any query that selects
by status blacklist (`status != 'rejected'`) therefore reads a debt that does not
exist yet.

Observed row counts with positive outstanding (2026-08-17):

| status | rows | no allocation | allocation open, landlord unpaid | landlord paid |
|---|---|---|---|---|
| service_center_review | 1,397 | 1,397 | 0 | 0 |
| pending | 230 | 230 | 0 | 0 |
| coo_approved | 13 | 13 | 0 | 0 |
| agent_ops_approved / tenant_ops_approved | 3 | 1 | 2 | 0 |
| funded | 93 | 9 | 24 | 60 |
| repaying | 588 | 156 | 45 | 387 |

~1,643 rows never reached the CFO yet surfaced as owing.

## The funding path (unchanged)

1. Agent posts request → `service_center_review` → ops chain → `coo_approved`.
2. CFO acts in `RentPipelineQueue` → edge function `fund-agent-landlord-float`:
   - accepts only `approved` / `coo_approved`, requires a TID (409 if already funded);
   - inserts one `agent_landlord_float_allocations` row
     (`source='cfo_disbursement'`, `status='open'`, `paid_out_amount=0`);
   - sets `rent_requests.status='funded'` + `funded_at`, posts the ledger legs
     (`rent_disbursement` platform cash_out / `rent_receivable_created` bridge
     cash_in) and the UGX 5,000 agent placement bonus.
3. **"Funded" means the money sits in the agent's landlord float — not that the
   landlord was paid.** The landlord is settled later, when `paid_out_amount > 0`
   on that allocation.

"Ready to fund" is only a stage label (`coo_approved`); it carries no
landlord-cash test.

## The rule (one definition, both surfaces)

`src/lib/collectibleRentRequests.ts` now holds the single client-side law,
mirroring the server view `v_agent_daily_eligibility`:

- **Status whitelist:** `funded`, `disbursed`, `repaying`, `completed`.
- **Disbursement evidence:** the request counts as collectible when the landlord
  was settled (`paid_out_amount > 0`) **or** the tenant already repaid something
  (`amount_repaid > 0`) **or** there is no open allocation blocking settlement.

`PriorityCollectionQueue` consumes both: it queries `.in('status', COLLECTIBLE_STATUSES)`
and then filters on `hasDisbursementEvidence()` using
`agent_landlord_float_allocations` (`status`, `paid_out_amount`) fetched in a
single batched query.

Inactive tenants (`agent_payment_status = 'not_paying'`) remain excluded from the
owed total, as before — their house is released back to Priority 1.

## Surfaces and their definitions after the fix

| Surface | Source | Definition |
|---|---|---|
| Priority Collections (agent) | `rent_requests` + allocations | whitelist + disbursement evidence |
| Daily target / Agent Ops ratings | `v_agent_daily_eligibility` | whitelist + disbursement evidence (server) |
| "What I owe Welile" (`useAgentCompanyExposure`) | `rent_requests` | already whitelisted (`funded`, `disbursed`, `repaying`, `completed`) |
| Today's capacity (`paid_today`) | `agent_collections` only | unchanged |

## Known residual gaps (not changed here)

1. **165 funded/repaying rows have zero allocation rows.** Status says funded but
   there is no disbursement evidence row. They pass the "no open allocation"
   branch on both surfaces. Fixing this needs a backfill of
   `agent_landlord_float_allocations` from the funding ledger legs, not a UI change.
2. **69 funded/repaying rows have an open allocation with the landlord still
   unpaid and no repayment yet.** These are now correctly held out of the owing
   list, but nothing in the pipeline forces landlord settlement before a tenant's
   repayment clock starts.
3. `total_repayment` / `daily_repayment` are still populated pre-funding. Any new
   query MUST use `collectibleRentRequests.ts` rather than filtering by status
   blacklist.
