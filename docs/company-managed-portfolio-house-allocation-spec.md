# Company-managed portfolios claim houses — implementation spec

**Status** Design agreed, not built. No code or data has been changed.
**Written** 2026-10-05, from live production figures.

---

## 1. What this does

When Partner Ops creates a **company-managed** portfolio, the system immediately
claims real empty houses whose rents add up to the principal. Those houses leave
the funder queue, so *"Amount needed to fund houses"* falls by the amount
claimed, and the portfolio carries a permanent record of which homes it is
supporting.

**No money moves at this point.** This is the rule that shapes everything below.

---

## 2. Live baseline

| | |
|---|---:|
| Houses in the queue | **6,451** |
| Amount needed | **UGX 5,830,028,954** |
| Median rent | 150,000 |
| Average rent | 903,740 |
| Cheapest / dearest | 10,000 / **500,000,000** |
| Houses under 500,000 | 5,717 (88.6%) |
| Company-managed portfolios today | **41**, UGX 114,720,000 |

Worked example, oldest-listing-first, principal 20,000,000:

```
claims        31 houses
uses          UGX 19,965,000
remainder     UGX      35,000
card          5,830,028,954 → 5,810,063,954
house count           6,451 → 6,420
```

---

## 3. Trigger and scope

Fires when a portfolio is created with **`pool_origin = 'company_managed'`**
(equivalently `pool_eligible = true` for that origin).

- **Never retroactive.** The 1,355 legacy portfolios (`pool_eligible = false`,
  UGX 9,630,493,466) are excluded permanently. They exceed the entire queue;
  including them would drive the card to zero and keep it there.
- **Per portfolio, at creation.** Each new portfolio allocates its own principal
  against whatever is in the queue at that moment. Nothing is pooled or
  re-balanced across portfolios.
- `self_support` portfolios are **out of scope** for now (1 portfolio, 50,000).

---

## 4. The algorithm

```
INPUT   portfolio P, principal = P.investment_amount

1. CANDIDATES
   house_listings where
        status = 'available'
    AND tenant_id IS NULL
    AND COALESCE(is_hidden,false) = false
    AND COALESCE(monthly_rent,0) > 0
    AND no live claim already exists on the house
          (neither a reserved promissory-note intent
           nor a live portfolio allocation)

2. GREEDY PACK   in the agreed order (see §11)
   running = 0
   for each candidate:
        if running + rent <= principal:
             claim it; running += rent

3. BEST-FIT FILL
   repeat: take the LARGEST remaining candidate whose rent <= (principal - running)
   until nothing fits.
   (207 houses are <= 35,000 and 723 are <= 50,000, so this usually
    closes the gap to a few thousand shillings.)

4. REMAINDER
   remainder = principal - running
   Store it on the portfolio. Do NOT re-sweep it later. Do NOT subtract it
   from the funder card.

5. NEVER OVERSHOOT
   A house is never claimed if its rent exceeds the principal still unclaimed.
```

### Why no re-sweep

A later sweep would reopen questions the books cannot answer cleanly: which
portfolio owns a house first when two have remainders, and what happens to a
claim made weeks after the ROI clock started. For a few thousand shillings it is
not worth the FIFO and reconciliation risk. **The remainder simply stays on the
portfolio as unallocated principal.**

---

## 5. What must NOT happen

This is the hard boundary. An allocation writes **one row per house and nothing
else**. Specifically it must not:

- create a `landlord_payouts` row
- create or touch `agent_landlord_float_allocations`
- place anything in the CFO disbursement queue
- post any `general_ledger` entry
- change `house_listings.status`, `tenant_id` or any landlord record

**The landlord is paid only when a real tenant takes the house and a Rent Plan
is funded through the normal flow.** Claiming a house is a commitment against
capital, not a payment.

It follows that the ROI obligation to the funder is unchanged. Allocation is a
queue-and-reporting mechanism; it does not alter what the company owes.

---

## 6. Data model

`promissory_note_house_intents` **cannot be reused.** Its `note_id` is `NOT NULL`
with an FK to `promissory_notes`, `agent_id` is `NOT NULL`, and it is `UNIQUE
(note_id, house_id)`. A portfolio allocation has no note and no agent, so reuse
would mean inventing a fake note per portfolio.

### New table

```
portfolio_house_allocations
  id                uuid pk
  portfolio_id      uuid not null  -> investor_portfolios(id)
  house_id          uuid not null  -> house_listings(id) on delete cascade
  monthly_rent      numeric not null      -- snapshot at claim time
  status            text not null default 'reserved'
                      -- reserved | fulfilled | released
  created_at        timestamptz not null default now()
  fulfilled_at      timestamptz           -- a tenant took this house
  released_at       timestamptz
  release_reason    text
  rent_request_id   uuid                  -- set when fulfilled
  UNIQUE (portfolio_id, house_id)
```

Plus a **partial unique index** so one house can only be claimed once at a time:

```sql
CREATE UNIQUE INDEX portfolio_house_allocations_one_live_claim
  ON public.portfolio_house_allocations (house_id)
  WHERE status = 'reserved';
```

### On `investor_portfolios`

```
houses_claimed_count     integer  default 0
principal_allocated      numeric  default 0
principal_unallocated    numeric  default 0   -- the remainder from §4.4
```

`monthly_rent` is snapshotted on the allocation row because the landlord may
change the listing price afterwards. The claim is against the price agreed at
claim time; otherwise the portfolio's supported total drifts silently.

---

## 7. Lifecycle

```
reserved     portfolio created, house claimed, queue reduced, NO money moved
fulfilled    a tenant took the house and a Rent Plan was funded
                 → house leaves `available` by itself, landlord paid by the
                   normal flow, allocation records rent_request_id
released     the house was let to someone else, de-listed, or Ops released it
                 → house returns to the queue, principal returns to the
                   portfolio's unallocated balance
```

**No expiry timer**, unlike promissory-note intents, which default to 7 days.
Company-managed capital is already committed and its ROI clock is already
running, so there is nothing to time out. A claim ends only by being fulfilled
or released.

### Precedence against agents — decided

If an agent registers a real tenant for a claimed house, **the tenant wins.**
The allocation moves to `released` with reason `let_to_tenant`, the house leaves
the queue anyway (it now has a tenant), and the principal returns to the
portfolio's unallocated balance. A reservation must never block an actual
letting.

---

## 8. The funder dashboard

`empty_house_opportunity_summary()` excludes a house when it has a **reserved
promissory-note intent**. It must now exclude a house claimed by **either**
mechanism.

Put that test in **one** function and call it from everywhere:

```sql
CREATE FUNCTION public.house_has_live_claim(p_house_id uuid) RETURNS boolean ...
  -- true when a reserved promissory-note intent exists
  --   OR a reserved portfolio_house_allocations row exists
```

`empty_house_opportunity_summary`, `useEmptyHouseMapCells`,
`SelfPortfolioFundingCard` and `useEmptyHouseTotalRentNeeded` all read this set.
If the rule lives in more than one place they will disagree within a week.

### Fix first, before anything else here

The current exclusion tests `status = 'reserved'` **only**, so a house whose
intent reaches **`funded` re-enters the queue.** One house is in that state
today (50,000/month, counted as "still needed" although it is funded). Under the
new flow `fulfilled` is the normal end state of every successful claim, so this
stops being a curiosity and becomes the default path. Widen it to
`status IN ('reserved','funded')` before building the rest.

---

## 9. Reporting

Per portfolio, from `portfolio_house_allocations`:

- **"This portfolio is supporting N homes"** — count where status = `reserved`
  or `fulfilled`
- the house list: district, rent, landlord, current state
- **principal allocated** vs **principal unallocated**, shown plainly so the
  remainder is never invisible money

Partner Ops should also get a platform view: total claimed, total unallocated
across portfolios, and claims released in the last 30 days with reasons.

---

## 10. Edge cases and guards

| Case | Behaviour |
|---|---|
| Principal smaller than the cheapest house (10,000) | Nothing claimed; entire principal sits unallocated. Allowed, and visible. |
| Queue is empty or fully claimed | Nothing claimed; entire principal unallocated. Never fail the portfolio creation. |
| The 500,000,000 listing | A packing rule will never reach it from a normal portfolio, and a portfolio large enough would spend itself on one house. **Verify this listing is real before go-live** — it is 8.6% of the whole queue and drags the average rent to 903,740 against a median of 150,000. |
| Portfolio cancelled or redeemed before any house is let | Release all `reserved` allocations; houses return to the queue. |
| Landlord raises the rent after the claim | Claim stands at the snapshotted `monthly_rent`. Flag the difference to Ops rather than silently re-pricing. |
| Two portfolios created at the same instant | The partial unique index on `house_id` makes a double claim impossible; the loser skips that house and takes the next. Allocation must run inside the portfolio-creation transaction. |

---

## 11. The one open decision

**Which houses does a portfolio claim first?** This decides which landlords get
served, so it is a business call, not a technical one.

| Order | Effect |
|---|---|
| **Oldest listing first** (my recommendation) | Fairest. The longest-waiting landlords clear first. 20M claims 31 houses. |
| Smallest rent first | Serves the most landlords per shilling; the queue's house count falls fastest; expensive listings may never be reached. |
| Highest-demand district first | Best occupancy odds, so claims convert to real tenancies sooner; concentrates support geographically. |

Everything else in this document is settled. Name the order and it can be built.

---

## 12. Build order

1. Widen the `funded` exclusion in `empty_house_opportunity_summary` (§8).
2. Add `house_has_live_claim()` and point every reader at it.
3. Create `portfolio_house_allocations` + the partial unique index.
4. Add the three columns to `investor_portfolios`.
5. Allocation routine, called inside company-managed portfolio creation.
6. Release path: tenant takes the house, Ops release, portfolio redeemed.
7. Portfolio-level reporting (§9).

Steps 1 and 2 are worth doing on their own whatever happens to the rest — the
queue is overstated today without them.

---

## 13. Verification queries

```sql
-- what a principal would claim, oldest-first, before building anything
WITH avail AS (
  SELECT h.id, COALESCE(h.monthly_rent,0) rent, h.created_at
  FROM public.house_listings h
  WHERE h.status = 'available' AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false AND COALESCE(h.monthly_rent,0) > 0
    AND NOT EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                     WHERE i.house_id = h.id AND i.status = 'reserved')
), packed AS (
  SELECT id, rent,
         SUM(rent) OVER (ORDER BY created_at, id
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) running
  FROM avail
)
SELECT COUNT(*) houses, SUM(rent) used, 20000000 - SUM(rent) remainder
FROM packed WHERE running <= 20000000;

-- the card, after go-live, must always equal the sum of unclaimed houses
SELECT (empty_house_opportunity_summary()->>'total_rent_needed')::numeric;
```
