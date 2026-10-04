# Landlord float backlog — 63 live plans whose landlord was never paid

Measured 2026-09-29 against production. Nothing in this document has been
changed automatically. It exists because the landlord-paid collection gate was
restored on the same day (`20260929090000_collection_waits_for_the_landlord_again.sql`)
and was deliberately **scoped to plans the 24-hour recall can act on**, which
leaves this backlog collecting. That was a decision to avoid cutting 26 agents
off mid-collection over a problem this migration cannot resolve. It is not a
judgement that the backlog is acceptable.

## The shape of it

| | |
|---|---|
| Live plans (repaying / funded / disbursed / active) | 806 |
| Of those, landlord float still open and **nothing paid out** | **65** |
| Funded on/after the recall go-live (now gated) | 2 |
| **Funded before go-live — this backlog** | **63** |
| Landlord money never delivered | **UGX 23,592,727** |
| Plans already collecting repayment from the tenant | **26** |
| Collected from those tenants so far | **UGX 6,363,938** |

`paid_out_amount = 0` on every one of the 65. Not a single shilling reached a
landlord through the allocation. None carries an idle-alert outcome of
`landlord_paid`. Oldest funding 2026-04-21, newest 2026-09-24.

## Why they are not simply stale rows

The obvious hope is that these landlords were paid outside the allocation
system and the rows were never closed. Two things argue against it:

- 25 of them are already parked by the recall as `pre_go_live_manual_review` —
  the detector saw them, could not establish what happened, and refused to act.
- 27 carry an idle alert with **no outcome at all**, meaning nothing has ever
  resolved them either way.

Both states mean *unknown*, not *paid*. The money has to be traced per plan.

## Per agent

| Agent | Plans | Owed to landlords | Already collected | Collecting | First | Last |
|---|---:|---:|---:|---:|---|---|
| Akampurira Onesmus | 14 | 7,160,000 | 3,649,979 | 13 | 2026-04-21 | 2026-05-15 |
| Martin Muhwezi | 3 | 2,432,727 | 1,022,000 | 3 | 2026-04-23 | 2026-05-15 |
| Mata Pius | 2 | 2,100,000 | 234,592 | 2 | 2026-07-29 | 2026-08-11 |
| kamulinde cosea Enoch | 6 | 1,800,000 | 0 | 0 | 2026-09-24 | 2026-09-24 |
| OACAR ARNOLD | 4 | 1,400,000 | 0 | 0 | 2026-05-15 | 2026-07-29 |
| Mukisa juli | 4 | 1,100,000 | 0 | 0 | 2026-09-17 | 2026-09-17 |
| Nabateregga Brenda Nakalema | 3 | 800,000 | 115,000 | 1 | 2026-05-14 | 2026-08-19 |
| Mugisha Emmanuel | 2 | 600,000 | 155,000 | 1 | 2026-09-08 | 2026-09-17 |
| Akandwanaho Wycliffe | 2 | 600,000 | 121,000 | 2 | 2026-05-05 | 2026-05-14 |
| ONESMUS AKAMPURIRA | 2 | 500,000 | 0 | 0 | 2026-09-11 | 2026-09-15 |
| GRACE PAUL OCHIENG | 1 | 500,000 | 495,867 | 1 | 2026-04-22 | 2026-04-22 |
| FRED MUWANGUZI | 3 | 500,000 | 179,000 | 1 | 2026-05-11 | 2026-09-15 |
| Saka Homi Melvin | 2 | 450,000 | 0 | 0 | 2026-09-17 | 2026-09-17 |
| KENNETH SEKABEMBE | 1 | 400,000 | 0 | 0 | 2026-09-17 | 2026-09-17 |
| Eric Natamba | 1 | 400,000 | 0 | 0 | 2026-05-15 | 2026-05-15 |
| PRISCILLA LOLEM | 1 | 300,000 | 314,500 | 1 | 2026-05-01 | 2026-05-01 |
| Thomas hawahka | 1 | 300,000 | 0 | 0 | 2026-09-17 | 2026-09-17 |
| Nabwire resty | 1 | 300,000 | 0 | 0 | 2026-09-15 | 2026-09-15 |
| Amanya Kwikiriza | 1 | 250,000 | 0 | 0 | 2026-09-10 | 2026-09-10 |
| Mwaka Isaac | 1 | 240,000 | 0 | 0 | 2026-09-22 | 2026-09-22 |
| Kwenseri Rodgers | 1 | 200,000 | 77,000 | 1 | 2026-05-05 | 2026-05-05 |
| Muyomba Peter | 1 | 200,000 | 0 | 0 | 2026-07-23 | 2026-07-23 |
| SULAIMAN MAYANJA | 1 | 200,000 | 0 | 0 | 2026-09-17 | 2026-09-17 |
| IAN MUHWEZI | 1 | 200,000 | 0 | 0 | 2026-05-15 | 2026-05-15 |
| waiswa Kenneth | 1 | 200,000 | 0 | 0 | 2026-09-15 | 2026-09-15 |
| Sandra Diana Amolo | 1 | 160,000 | 0 | 0 | 2026-09-22 | 2026-09-22 |
| Munguhili Happy | 1 | 150,000 | 0 | 0 | 2026-09-15 | 2026-09-15 |
| Baganzi Ali | 1 | 150,000 | 0 | 0 | 2026-09-15 | 2026-09-15 |

Two names to look at before anything else:

- **Akampurira Onesmus** — 14 plans, 7.16m owed to landlords, and 13 of them
  have collected 3.65m from tenants. That is a quarter of the whole backlog
  sitting with one agent. Note `ONESMUS AKAMPURIRA` appears separately with 2
  more plans; worth confirming whether that is the same person with two
  accounts.
- **kamulinde cosea Enoch** — 6 plans, 1.8m, all funded on a single day
  (2026-09-24), none collecting. A same-day cluster reads more like a funding
  batch that never got paid out than six independent lapses.

## What this needs from a human, in order

1. **Trace the money for the 26 collecting plans first.** The tenant is paying;
   whether the landlord ever got theirs decides if this is a bookkeeping gap or
   a shortfall. Start with Akampurira Onesmus.
2. **Decide per plan, not in bulk**: landlord paid outside the system → close
   the allocation and leave collection running; landlord genuinely unpaid →
   pay them, or unwind the plan and refund the tenant what was collected.
3. **The 37 not collecting are cheaper to resolve** — no tenant money is
   involved yet, so they can be recalled or paid out without a refund.
4. **Once a decision rule exists**, the gate's scope can be widened from
   `landlord_float_recall_go_live()` to cover whatever remains. Until then,
   widening it only blocks collection without paying a single landlord.

## How to re-run these numbers

```sql
with live as (
  select rr.id, rr.amount_repaid,
         coalesce(rr.assigned_agent_id, rr.agent_id) agent_id
  from public.rent_requests rr
  where rr.status in ('repaying','funded','disbursed','active')
), oa as (
  select a.rent_request_id, sum(a.remaining_amount) owed, min(a.created_at) alloc_created
  from public.agent_landlord_float_allocations a
  where a.status in ('open','partially_paid')
    and coalesce(a.paid_out_amount,0) = 0
    and a.remaining_amount > 0
  group by 1
)
select count(*) plans, sum(oa.owed) owed_to_landlords,
       sum(l.amount_repaid) collected_from_tenants,
       count(*) filter (where l.amount_repaid > 0) plans_collecting
from live l join oa on oa.rent_request_id = l.id
where oa.alloc_created < public.landlord_float_recall_go_live();
```

Drop the final `where` line to include the 2 plans the gate now covers.
