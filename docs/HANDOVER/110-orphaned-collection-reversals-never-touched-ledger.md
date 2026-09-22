# 110 — 1,225 "reversed" `agent_collections` rows never touched the ledger; 59 rent plans were falsely `completed`

**59 rent plans patched live 2026-09-22 (status + `amount_repaid` corrected). The other ~1,166
orphaned rows — UGX 98.6M of unreversed ledger legs across 23 agents — are NOT fixed, investigation
only for those. Before touching `agent_reverse_tenant_allocation`, `admin_void_unverified_collection`,
or trusting any `agent_collections.reversed_at` row as financially undone, read this.**

## What happened

Investigating a tenant complaint — Katende Husein (`7dc1d144-e87b-435d-9aaf-60821a26edbf`,
+256753306524) was being told his rent plan was "completed" while his agent kept collecting money
from him — traced to his second rent plan (`adf2339b-bfc5-4baa-9083-0bb87a375fe0`). On 2026-09-16 a
float-gate defect created 3 duplicate UGX 80,000 collections; someone corrected it, but only by
setting `agent_collections.reversed_at` + appending `[REVERSED: duplicate submission, 2026-09-15
float-gate defect...]` to `notes` — **not** by calling `agent_reverse_tenant_allocation`, the RPC that
actually undoes the ledger legs and recomputes `rent_requests.amount_repaid`/`status`. Real cash
collected on his plan: UGX 179,000. System showed: UGX 419,000 / `completed`. `tenant_rent_plan_detail()`
(the RPC his app calls) only returns a plan when `status IN ('funded','disbursed','repaying')` — so a
falsely-`completed` plan renders as "nothing owing," which is exactly what he was seeing while his
agent, correctly, kept asking for the real UGX 240,000 shortfall.

Josh confirmed this wasn't isolated ("I KNOW THERE ARE AGENTS WHO DID THE SAME THING") — checked
platform-wide.

## Scope, verified live

`agent_collections.reversed_at IS NOT NULL`: **1,272 rows** total, splitting cleanly into two buckets
by `notes`:

| Path | Rows | Ledger actually reversed? |
|---|---:|---|
| `admin_void_unverified_collection` (doc 93's RPC, `[VOID by ...]` notes) | 46 | **Yes** — mirrors every matched `general_ledger` leg, flipped |
| `agent_reverse_tenant_allocation`-shaped (`[REVERSED: ...]` notes) | 1,226 | **Only 1 of them** |

Confirmed the "only 1" by counting genuine reversal ledger entries platform-wide:
`general_ledger.description ILIKE 'Reversal of float allocation%'` → exactly 1 row
(`REV-ALLOC-53EFA6E9`). The other **1,225** `[REVERSED: ...]` rows have `reversed_at` set and a note,
but zero matching `general_ledger` reversal — meaning whoever/whatever set them did a direct
`UPDATE agent_collections SET reversed_at = ...` and skipped the RPC (and its ledger/commission/
`amount_repaid` recompute) entirely. No actor is recorded (no `admin_void_unverified_collection`-style
audit trail exists for this path) — could not identify who or what did this.

Blast radius of those 1,225 orphaned rows:

- **23 distinct agents, 119 distinct rent plans (= 119 tenants)**
- **UGX 98,647,719** total in still-standing phantom ledger legs (agent commission, recruiter-override
  commission, "cash received by agent — held in custody", and "tenant rent allocation settled for
  landlord" entries that were never reversed)
- **102 of the 119 plans** have `amount_repaid` inflated above what was actually collected — UGX
  30,846,989 of phantom "repaid" total across them
- **59 of the 119** were sitting at `status = 'completed'` while genuinely still owing money — Katende
  Husein's exact failure mode, each one silently telling its tenant "done" while `agent_collections`
  proves otherwise

## What was fixed (this session)

Only the 59 falsely-`completed` plans, and only the tenant-facing status/balance field — **not** the
underlying ledger legs, commission, or landlord-settlement figures for any of the 1,225 rows (Josh's
explicit choice, given the size of the full remediation). Recompute mirrors
`agent_reverse_tenant_allocation`'s own formula exactly:

```sql
new_amount_repaid = LEAST(total_repayment,
                     GREATEST(valid_collected,              -- sum(amount) where reversed_at IS NULL
                              GREATEST(0, amount_repaid - orphaned_reversed_sum)))  -- blind subtraction
new_status = CASE WHEN new_amount_repaid >= total_repayment THEN 'completed' ELSE 'repaying' END
```

`valid_collected` and the blind-subtraction floor agreed on every one of the 59 rows (both landed on
the same number), so there's no ambiguity in what "actually collected" means here. Update was guarded
(`WHERE amount_repaid = <old value> AND status = 'completed'`) so it only touched rows matching the
values just read. All 59 verified `status = 'repaying'` post-update, including Katende Husein's plan
(now `179,000 / repaying`, correctly showing UGX 240,000 outstanding).

Full list of the 59 rent_request ids is in this session's transcript / re-derivable with the query
below.

## What was NOT fixed — explicitly deferred

- **The other ~1,166 orphaned rows** on plans that are *not* currently `completed` (i.e. `amount_repaid`
  is inflated but the plan still correctly shows as owing something, just less than it should).
- **Any ledger correction.** No commission clawback, no landlord-settlement correction, no "cash in
  transit" correction was made for any of the 1,225 rows — including the 59 that got their
  `rent_requests` row fixed. The UGX 98.6M in phantom ledger legs (agent wallets, recruiter overrides,
  landlord receivables) is still standing exactly as it was. This means:
  - The 23 agents' commission-earned totals are still overstated by their share of that figure.
  - Landlord settlement figures referencing these `rent_request_id`s still show more "settled" than
    was really collected.
- **Root cause of the 1,225 direct updates.** Same gap as doc 101/103's `email_queue_dispatch`
  investigations — no audit trail, migration history, or Lovable edit history points to an actor. Could
  be a bulk manual fix, a script, or a Lovable edit that was never captured anywhere queryable.

## What not to do

- Don't treat `agent_collections.reversed_at IS NOT NULL` as proof a collection was financially undone
  — check for a matching `general_ledger` reversal (or a `[VOID by ...]` note, doc 93's path) before
  trusting it.
- Don't re-run the 59-plan fix — it's already applied and idempotent-guarded against re-application
  (the `WHERE amount_repaid = <old>` guard means re-running the same query now finds 0 matching rows).
- Don't assume the full ledger remediation is scheduled — it isn't; this doc's numbers are what a
  follow-up would need to reverse, and doing so touches 23 agents' wallet balances and landlord
  receivables, not just `rent_requests`.

## Verify this is still the state

```sql
-- Orphaned (never ledger-reversed) rows remaining
select count(*), count(distinct agent_id), count(distinct rent_request_id), sum(amount)
from agent_collections
where notes ilike '%[REVERSED:%' and tracking_id <> 'ALLOC-53EFA6E9';

-- Any plan still falsely showing completed
with orphaned as (
  select rent_request_id, sum(amount) orphaned_sum
  from agent_collections
  where notes ilike '%[REVERSED:%' and tracking_id <> 'ALLOC-53EFA6E9'
  group by rent_request_id
),
valid as (
  select rent_request_id, coalesce(sum(amount),0) valid_sum
  from agent_collections where reversed_at is null group by rent_request_id
)
select rr.id, rr.status, rr.total_repayment, rr.amount_repaid, v.valid_sum
from rent_requests rr
join orphaned o on o.rent_request_id = rr.id
left join valid v on v.rent_request_id = rr.id
where rr.status = 'completed' and coalesce(v.valid_sum,0) < rr.total_repayment;
```
