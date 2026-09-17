# Completed Rent Plans appearing in "Unpaid days to recover" — 2026-09-17

Investigation only. No code, schema or data was changed.

## Reported

Agent **JAMES KATONGOLE** (`16d52ad2-92e0-4348-af46-17612afa4d49`) sees "UNPAID DAYS TO RECOVER
UGX 3,210,754 · 3 tenants behind", the first being **Serwadda John** — "1 day behind since
2026-09-10" — a tenant whose plan he says is finished. Expectation: such a tenant belongs in the
**expired cycle** section, not the missed-payments section.

## Confirmed

All three "behind" tenants are on plans whose status is already `completed`:

| Tenant | Plan | Status | Total | Repaid | Term end | Arrears shown |
|---|---|---|---|---|---|---|
| Serwadda John | `e8e5c372…` | completed | 2,322,223 | 2,322,223 | 2026-09-16 | 1,683,723 |
| twesige agnes | `035e95a5…` | completed | 3,345,000 | 2,680,000 | 2026-10-08 | 1,152,027 |
| Namakula Saidat | `03f50a4e…` | completed | 2,680,000 | 2,680,000 | 2026-10-08 | 375,004 |

Two of the three are **fully repaid** (`total_repayment - amount_repaid = 0`) yet still counted as
in arrears. Meanwhile `agent_expired_cycles(agent)` returns **zero plans** for him, so the tenant
appears in neither the right section nor as settled.

## Why

Three independent causes stack up.

1. **The arrears view accepts `completed` plans and never checks the plan balance.**
   `v_rent_plan_arrears` reads pinned days from `agent_expected_day_plans` and subtracts
   `rent_day_settlements`. Nothing in that chain looks at `rent_requests.status` or at
   `total_repayment - amount_repaid`. A day pinned while the plan was live stays "open" forever
   after the plan closes.

2. **Settlement only sees `agent_collections`, while completion is written from `amount_repaid`.**
   Serwadda John's plan has UGX 638,500 of `agent_collections` rows but `amount_repaid` = the full
   UGX 2,322,223. The plan was closed on the balance figure; the day ledger only ever saw the
   638,500, so the UGX 1,683,723 difference is permanently displayed as unpaid days.

3. **A whole week was pinned onto a single day.** For that plan the daily instalment is UGX
   331,747, but the pinned row for 2026-09-10 carries UGX **2,322,223** — the entire plan total on
   one day. Same pattern on twesige agnes: six normal days of 89,334 then a lump of **780,500** on
   2026-09-16. This is why the "1 day behind" figure is 1.68M rather than one day's rent.

4. **The expired-cycle section can never catch these**, because `agent_expired_cycles` only lists
   plans with `total_repayment - amount_repaid > 0`. A fully-repaid past-term plan is invisible
   there while still being counted as arrears.

## Scope — is it hitting other agents?

Of **512** plans currently showing arrears (UGX 45,000,884 total):

- **6 plans** are on `completed` status — UGX **3,880,771** of phantom arrears across **3** agents:
  JAMES KATONGOLE (3 plans, 3,210,754), IAN MUHWEZI (2 plans, 558,668), mbeiza peruth (1 plan,
  111,349).
- **4 plans** are fully repaid (nothing owed at all) yet show UGX **2,617,395** of arrears across
  2 agents.
- The single-day lump pinning is wider: **15 pinned rows** on **14 plans** across **7 agents** carry
  an expected amount more than 1.5× that plan's daily instalment, UGX 5,605,617 in total.

So it is not isolated to this agent, but it is contained: roughly 1% of arrears rows, concentrated
in a handful of agents. No money moved incorrectly — `rent_day_settlements` never alters what a
tenant owes; this is a reporting-layer fault that produces false "tenant behind" warnings.

## Recommendations (not implemented)

1. Exclude plans with `status = 'completed'` or `total_repayment - amount_repaid <= 0` from
   `v_rent_plan_arrears`, or cap a plan's arrears at its actual outstanding balance — the cheapest
   correct fix and it resolves all three of Katongole's rows.
2. Drop the `> 0` outstanding filter in `agent_expired_cycles` (or add a "closed, past term"
   listing) so a finished tenant is visibly finished rather than silently absent.
3. Reconcile the settlement source: either settle days from `amount_repaid`/`repayments` as well as
   `agent_collections`, or refuse to mark a plan `completed` when the day ledger disagrees, and
   report the gap.
4. Investigate the lump pinning — pinned `expected_ugx` should never exceed the plan's daily
   instalment (weekly plans excepted, and those should be labelled as a week, not a day, in the UI).
