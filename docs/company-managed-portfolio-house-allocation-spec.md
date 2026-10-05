# Company-managed portfolios claim houses — implementation spec

**Status** Design agreed, not built. Revised 2026-10-05 after review. No code or data has been changed.
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

### Empty houses only — Rent Plans are out of scope

Allocation reads **`house_listings`** and nothing else. It must not look at
`rent_requests`, and it must not claim against fundable Rent Plans.

The two are different products and the platform already treats them separately:
the funder hero reads `empty_house_opportunity_summary()` (empty houses), while
`SelfPortfolioFundingCard` reads `partner_self_list_fundable_plans()` (Rent
Plans). Only the first is affected by this feature. A later phase may extend it
to Rent Plans; until then, mixing them would make the 5.83B figure stop meaning
what its own subtitle says.

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

### Allocation never blocks portfolio creation

**The portfolio is always created. Allocation is best-effort and may claim
nothing at all.** There are exactly three outcomes, and all three are valid:

| Outcome | When | Result |
|---|---|---|
| **Full** | enough houses fit the principal | houses claimed, small or zero remainder |
| **Partial** | the queue runs out mid-pack, or only some houses fit | the houses that fit are claimed; the rest of the principal is unallocated |
| **None** | the queue is empty, fully claimed, or the principal is smaller than the cheapest available house | **no houses claimed, the whole principal is unallocated** |

A 50,000 or 100,000 portfolio is a normal case, not an error. The cheapest house
in the queue is 10,000, so a 50,000 portfolio will usually claim one to three
houses — but if the only houses left are dearer than the principal, it claims
none and that is correct. The portfolio still exists, still earns its ROI, still
appears in reporting, and simply shows **0 homes supported**.

The same applies when the queue is exhausted. Houses run out long before capital
does, and that must never stop Partner Ops creating a portfolio.

**Implementation consequence:** the allocation routine must never raise. A
failure inside it must not roll back the portfolio insert. Log the reason
(`queue_empty`, `principal_below_cheapest_house`, `no_fitting_house`) on the
portfolio so Ops can see *why* nothing was claimed rather than wondering whether
it broke.

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
| Principal smaller than the cheapest house (10,000) | Nothing claimed; entire principal unallocated, reason `principal_below_cheapest_house`. Portfolio created normally. |
| Queue empty or fully claimed | Nothing claimed; entire principal unallocated, reason `queue_empty`. Portfolio created normally. |
| Queue runs out mid-pack | Claim what fits, leave the rest unallocated. Partial is a valid end state. |
| Small portfolio (50,000 / 100,000) | Normal case. Usually claims 1–3 houses; claims none if nothing fits. Never an error. |
| Allocation routine throws | Portfolio insert must still commit. Allocation is best-effort and never rolls back the portfolio. |
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

## 11b. Pool membership, provenance, and making room for Rent Plans

This section replaces the house-only table in §6. Build this shape from the
start, even though phase one claims empty houses only — retrofitting a
polymorphic target onto a live allocation table is far more expensive than
carrying one unused column for a few weeks.

### 11b.1 How we know a portfolio is company-managed — and the gap today

`pool_origin = 'company_managed'` is the **only** marker that exists, and it
records *what* the portfolio is, never *who* made it.

`investor_portfolios` has **no `created_by` column.** Its `agent_id` is the
referring agent, not the creator — measured 2026-10-05, the roles behind that
column come back as `tenant` (16), `supporter` (29) and one null across the
company-managed set. **Nothing in the data says a Partner Ops or COO desk
created these.**

So the first thing to add is provenance, on the portfolio itself:

```
investor_portfolios
  created_by        uuid     -- the human who clicked create
  created_by_role   text     -- 'partner_ops' | 'coo' | ... resolved at creation
  created_via       text     -- the edge function or RPC that did it
```

The creating edge function must stamp all three from the authenticated caller.
Do not infer the desk later from roles — staff change roles, and a portfolio's
provenance must not change with them.

**`pool_origin` stays the authority on membership**, and `created_by_role` is
the audit of who put it there. Keep them separate: one is what the money *is*,
the other is who decided. Allocation fires on `pool_origin`, never on the role,
so a future desk or an automated job can create company-managed portfolios
without touching the allocation rule.

### 11b.2 One allocation table, two kinds of target

Rent Plans are coming, so the table is **not** house-specific. Replace
`portfolio_house_allocations` with:

```
portfolio_allocations
  id                   uuid primary key default gen_random_uuid()
  portfolio_id         uuid NOT NULL REFERENCES investor_portfolios(id)

  -- WHAT is claimed -----------------------------------------------------
  target_type          text NOT NULL            -- 'empty_house' | 'rent_plan'
  house_id             uuid REFERENCES house_listings(id) ON DELETE CASCADE
  rent_request_id      uuid REFERENCES rent_requests(id)

  -- HOW MUCH ------------------------------------------------------------
  claimed_amount       numeric NOT NULL         -- snapshot, see 11b.3
  claimed_basis        text NOT NULL            -- 'monthly_rent' | 'plan_principal'

  -- STATE ---------------------------------------------------------------
  status               text NOT NULL DEFAULT 'reserved'
                                                -- reserved | fulfilled | released
  created_at           timestamptz NOT NULL DEFAULT now()
  fulfilled_at         timestamptz
  fulfilled_rent_request_id uuid                -- the plan an empty house became
  released_at          timestamptz
  release_reason       text

  -- PROVENANCE, denormalised on purpose ---------------------------------
  pool_origin          text NOT NULL            -- 'company_managed'
  created_by           uuid NOT NULL
  created_by_role      text NOT NULL
  created_via          text NOT NULL
```

**Why denormalise `pool_origin` onto the allocation row.** A pool report should
not have to join back to the portfolio to know what kind of money claimed a
house, and more importantly the row must keep saying `company_managed` even if
someone later edits the portfolio. The claim is a historical fact; it should not
be rewritten by a change made afterwards.

### 11b.3 The trap: the two targets are not the same unit

| target_type | claimed_basis | What the number means |
|---|---|---|
| `empty_house` | `monthly_rent` | **one rent cycle** for a house with no tenant |
| `rent_plan` | `plan_principal` | the **full principal** of a live funded plan |

These must never be summed blind. A 300,000 house claim and a 300,000 plan claim
are different commitments over different horizons, and `SUM(claimed_amount)`
across mixed rows would be a meaningless figure on a dashboard.

**Rule:** every report that totals allocations either filters by `target_type`
or shows the two subtotals separately. `claimed_basis` exists so a reader can
never be in doubt which it is holding.

### 11b.4 Integrity

```sql
-- exactly one target, and it must match the declared type
ALTER TABLE public.portfolio_allocations ADD CONSTRAINT portfolio_allocations_target_shape
  CHECK (
    (target_type = 'empty_house' AND house_id IS NOT NULL AND rent_request_id IS NULL)
    OR
    (target_type = 'rent_plan'   AND rent_request_id IS NOT NULL AND house_id IS NULL)
  );

-- a house can carry only one live claim
CREATE UNIQUE INDEX portfolio_allocations_one_live_house
  ON public.portfolio_allocations (house_id) WHERE status = 'reserved';

-- and so can a rent plan
CREATE UNIQUE INDEX portfolio_allocations_one_live_plan
  ON public.portfolio_allocations (rent_request_id) WHERE status = 'reserved';

-- pool queries
CREATE INDEX portfolio_allocations_pool
  ON public.portfolio_allocations (pool_origin, status, target_type);
```

The CHECK is what stops the table rotting. Without it a row can declare
`empty_house` while carrying a `rent_request_id`, and every reader downstream
has to defend against it.

### 11b.5 Portfolio-level counters

```
investor_portfolios
  houses_claimed_count     integer NOT NULL DEFAULT 0
  plans_claimed_count      integer NOT NULL DEFAULT 0
  principal_allocated      numeric NOT NULL DEFAULT 0
  principal_unallocated    numeric NOT NULL DEFAULT 0
  allocation_note          text   -- queue_empty | principal_below_cheapest_house | no_fitting_house
```

Two counters, not one, for the reason in 11b.3. `principal_allocated +
principal_unallocated` must always equal `investment_amount` — that invariant is
the cheapest possible check that the allocator is behaving, and it is worth a
health-check row in the CTO monitor.

### 11b.6 What changes when Rent Plans are switched on

Nothing structural. Phase two is:

1. extend the candidate query to also select fundable Rent Plans
2. write rows with `target_type = 'rent_plan'`, `claimed_basis = 'plan_principal'`
3. widen the "is this already claimed" predicate to cover `rent_request_id`
4. split the dashboard figures by `target_type`

No table change, no backfill, no migration of existing rows. That is the whole
reason for building the polymorphic shape now rather than later.

Until phase two the allocator writes `target_type = 'empty_house'` only, and
`rent_request_id` stays null on every row.

### 11b.7 Reading the pool

```sql
-- what company-managed money is currently supporting
SELECT target_type, status, COUNT(*) AS claims, SUM(claimed_amount) AS amount
  FROM public.portfolio_allocations
 WHERE pool_origin = 'company_managed'
   AND status IN ('reserved','fulfilled')
 GROUP BY target_type, status;

-- the invariant that must never break
SELECT COUNT(*) AS portfolios_out_of_balance
  FROM public.investor_portfolios
 WHERE pool_origin = 'company_managed'
   AND ROUND(principal_allocated + principal_unallocated) <> ROUND(investment_amount);
```

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
