# 57 — Phantom "1 day behind" arrears from a missed day-1 pin

**Fixed in migration, NOT yet applied to production — blocked by the same auto-mode classifier as
docs 55/56 ("Production Deploy"), needs Josh to run it by hand in the Supabase SQL editor.** Before
touching `rent_apply_collections_to_days`, `pin_agent_expected_day`, or trusting an "Unpaid Days To
Recover" / arrears figure from `AgentArrearsCard`, `agent_arrears_overview`, `rent_plan_day_ledger`,
or `v_rent_plan_arrears`.

## What was reported

Screenshot of agent Shakirah Nakimbugwe's own Agent Dashboard: "Unpaid Days To Recover — UGX
27,934 — 2 tenants behind" (Hamiss Mutyaba, 1 day behind since 2026-09-16; Faizal Kayondo, 1 day
behind since 2026-09-12), while Shakirah maintains she's never missed a payment.

## Root cause, confirmed against production

Both tenants had collected **100% of every billed day, in full, on schedule** — 6/6 days for
Faizal (UGX 70,500 expected, UGX 70,500 collected), 2/2 for Hamiss (UGX 32,368 both sides). The
"behind" flag was a false positive.

`v_rent_plan_schedule` gates a plan on landlord-payout evidence:

```sql
... AND (COALESCE(rr.amount_repaid,0) > 0
      OR le.rent_request_id IS NULL
      OR le.paid_out > 0
      OR COALESCE(le.open_allocs,0) = 0)
```

That gate is evaluated live, at the instant `pin-agent-expected-day-eat-midnight` runs (00:05 EAT).
For both tenants, the landlord's `agent_landlord_float_allocations` row was still `open` (not yet
paid out) at that exact moment, and the tenant hadn't paid anything yet either — so the gate failed
and the plan's **very first billed day was silently never pinned** into
`agent_expected_day_plans`:

| Tenant | Funded | Landlord actually paid out | Midnight pin for day 1 ran |
|---|---|---|---|
| Faizal Kayondo | 2026-09-11 12:04 UTC | 2026-09-12 05:14 UTC | 2026-09-11 21:05 UTC |
| Hamiss Mutyaba | 2026-09-15 16:07 UTC | 2026-09-16 07:12 UTC | 2026-09-15 21:05 UTC |

The payout cleared *after* the midnight pin and *before* the tenant's first payment — exactly the
gap the gate blocks on. There is no retry for a missed day: the cron only ever calls
`pin_agent_expected_day(today)`. The only other caller, `get_agent_collections_command_center`,
opportunistically re-pins arbitrary past days when a report happens to query a range covering one
— which is what finally backfilled both missing rows, 5 and 1 days late respectively, at the
identical timestamp `2026-09-17 07:00:48 UTC` (confirmed via `agent_expected_day_plans.captured_at`).

By the time it backfilled, the damage was done: with day 1 not existing yet, the tenant's real
day-1 collection had nowhere to settle except whatever day *did* exist at sweep time (day 2), so
`rent_apply_collections_to_days`'s FIFO waterfall correctly-but-wrongly attributed it there. Every
subsequent collection rolled forward the same one day. When day 1 was finally backfilled, there was
no unapplied money left to give it — the old allocator only ever moved *unapplied* funds onto open
days, never pulled money back off an already-settled later day. Day 1 sat open forever: a permanent
phantom one day's rent in arrears despite full, on-time payment.

Scope: of 637 currently-repaying plans, 33 showed exactly "1 day behind" at the time of
investigation; spot-checking found several more with zero or even positive net collections
(over-collected) still flagged — same mechanism. This is a reporting-layer bug only — per the
phase-1 design doc, `rent_day_settlements` never changes `total_repayment - amount_repaid`, so no
real money moved incorrectly and no penalty/liability cron reads this table directly. It does,
however, produce false "tenant behind" warnings to agents and ops.

## Fix — `supabase/migrations/20260917120000_fix_arrears_day1_pin_gap.sql`

Two parts, neither changes what any tenant owes:

1. **`pin_agent_expected_day_for_plan(rent_request_id)`** — new function, backfills any day from a
   single plan's `term_start` to today that the gate now allows but didn't at pin time. Cheap
   (scoped to one plan, `ON CONFLICT DO NOTHING`).
2. **`rent_apply_collections_to_days` rebuilt** — now (a) runs that catch-up first, then (b) fully
   re-derives the plan's `rent_day_settlements` from *every* collection against *every* pinned day
   (delete + rebuild) instead of only ever moving money that was still "unapplied." This is what
   lets a late-arriving day 1 pull money back from whichever later day absorbed it.
3. **`pin_agent_expected_day_catchup(lookback_days default 6)`** — new nightly cron target
   (replaces the bare `pin_agent_expected_day(today)` call on `pin-agent-expected-day-eat-midnight`,
   same 00:05 EAT schedule). Pins a trailing week and rebalances any plan with an open day in that
   window — the backstop for a plan that misses its day-1 pin and never gets another collection to
   trigger the fix above.
4. The migration ends by calling `pin_agent_expected_day_catchup(30)` once, to repair every plan
   already affected (30 days comfortably covers everything back to the 2026-09-10 arrears go-live
   floor).

**To apply:** run the migration file's contents in the Supabase SQL editor. It is idempotent and
safe to re-run. After applying, `select agent_arrears_overview('34ed279b-f6cf-4291-ab0f-1339b8afe28c')`
should show zero arrears for Shakirah's two tenants — verify that as the smoke test.
