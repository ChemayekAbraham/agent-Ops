# 188 — Parked top-ups on monthly_compounding portfolios never merged

**Built 2026-10-02. Migration `20261002130000_merge_topups_after_compounding_roi.sql`, not yet applied.**

## What the partner saw
Joshua Wanda (0704825473) moved UGX 100,000 from wallet to FOUNDATION (WPF-0853)
on 2026-09-30 13:22 UTC. Ledger: wallet `cash_out` + platform `cash_in` "Pending
capital for FOUNDATION — applied on next payout". Principal stayed 3,581,390.
On 2026-10-02 07:31 UTC the portfolio was compounded (3,581,390 → 4,297,668, exactly
+20%) **without** the 100,000. The pending op `58e6778d…` is still `approved`. The
admin confirmed the system never applied it.

## Root cause
Merging moved out of `process-supporter-roi` (inline merge disabled 2026-06-12) into
`public.merge_paidout_topups()`, cron `merge-paidout-topups-7pm` (job 74, 16:00 UTC).
That function only merges when the portfolio has an approved/completed `roi_payout`
or `supporter_platform_rewards` op, using its `reviewed_at` as the payout moment:
`IF v_last_payout IS NULL THEN CONTINUE`.

A `monthly_compounding` portfolio never has such an op. Its Returns are compounded
by the COO action (`COOPartnersPage.handlePortfolioCompound`), which writes
`investor_portfolios` + `roi_expense`/`roi_reinvestment` ledger legs + an
`audit_logs` row `action_type='roi_compounded'` and nothing else. So the cron skipped
every compounding portfolio forever. Every earlier top-up on WPF-0853 was merged by
hand ("capital activated manually").

## Rule (Josh, 2026-10-02)
On the day a portfolio receives its ROI, all pending top-ups are applied
automatically.

## Change
`merge_paidout_topups()` now has a second path for `roi_mode='monthly_compounding'`
portfolios with no payout op:
- evidence = latest `roi_compounded` audit row for the portfolio, and only if it is
  **within the last 48h** (never reaches back into older cycles);
- merges top-ups created **at or before** that compound (later ones wait for the next
  ROI day);
- same ledger legs, audit row, notification and `completed` status as the payout path.
The payout-op path (10-day grace) is unchanged. Net effect: the 16:00 UTC run on the
ROI day merges what was parked at compound time.

Gotcha caught while writing it: `audit_logs.record_id` is **text** in production, so
the join casts `rec.id::text`; without the cast the whole function errors and no
portfolio merges.

`merge_paidout_topups` is not in `critical_function_baselines`, so no re-baseline.

## What tonight's run will merge (measured 2026-10-02 08:50 UTC)
Compounding portfolios compounded in the last 48h with parked ops created before it:
- WPF-0853 FOUNDATION: UGX 100,000 (the case above)
- WIP2602017335: UGX 900,000 (op 09-28, compounded 10-02)
- WIP2601315629: UGX 10,000,000 (op 09-30, compounded 10-01)

## Open: older backlog deliberately NOT swept
`approved` top-ups on compounding portfolios whose compound was earlier than 48h ago
(each should have merged at its own ROI day, none did). Needs a decision, because
merging raises principal and therefore future Returns:
WIP2608047882 100k (op 09-01), WIP2608122658 100k, WIP2608251550 4,000,000,
WIP2606263583 100k, WIP2607238837 1,000,000, WIP2606242054 550,000,
WIP2607293112 2,000,000, WIP2606122212 100k, WIP2604094188 2,000,000,
WPF-6595 700,000 (op 09-28, compounded 09-07 → waits for its next ROI day),
WIP2610044671 3,000,000 and WIP2608062897 2,000,000 (ops 09-30, wait for next ROI),
WIP2604226578 2 × 1,000 (op 06-17).
The ones created after their last compound are not backlog, they simply wait for
their next ROI day.

## Also not fixed
- WPF-0853 compounded 2026-10-02 on 3,581,390; the 100,000 earns nothing for that
  cycle. Ordinary, matches the "merge after payout" design. Decide separately if a
  one-off make-good is wanted.
- `monthly_payout` portfolios with `approved` ops and no `roi_payout` op (e.g.
  WIP2512011815 17,000,000) have the same NULL-skip; not touched here.
- `handlePortfolioCompound` is a frontend-driven money write (ledger RPC + direct
  `investor_portfolios` update). Worth moving behind an RPC; out of scope.
- Architecture map not updated: it has no node for partner portfolio top-up merging
  or compounding to attach this to.

## Deploy
Apply the migration, then verify `pg_get_functiondef('merge_paidout_topups()')`
contains `roi_compounded`. After the 16:00 UTC run, WPF-0853 principal should be
4,397,668 and op `58e6778d…` `completed`.
