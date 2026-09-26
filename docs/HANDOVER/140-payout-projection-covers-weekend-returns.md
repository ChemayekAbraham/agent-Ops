# 140 — Payout projection covers weekend Returns (Sat–Mon on Monday)

**Status (2026-09-26): committed, NOT applied.** Needs migration
`20260926150000_payout_projection_multi_day_range.sql` and a deploy of
`daily-payout-projection-report`. The nightly cron (`20260925140100`, doc 133) is
**still not scheduled** (no `cron.job` row), so nothing is emailed automatically yet.

## The question (Josh, 2026-09-26)
Supporter Returns aren't paid on Saturday or Sunday; everything is paid on Monday.
How should Monday's plan look if compounding Returns are kept out, and landlord
payouts, wallet withdrawals and a safety increment are added?

## The gap
`get_next_day_payout_projection(p_date)` listed only Returns with
`next_roi_date = p_date`. Sunday's email would have shown Monday's UGX 44.2M and
missed Saturday + Sunday (UGX 76M). Weekend Returns aren't moved by any job
(`process-supporter-roi` works on `rent_requests`; portfolio Returns keep their
`next_roi_date` until someone pays them via `approve-wallet-operation`), so a date
range finds them intact on Monday.

## What changed
`get_next_day_payout_projection(p_date date, p_from date, p_cushion_pct numeric default 10)`.
The old one-argument signature is dropped, and callers passing only `p_date` still resolve.

| Output | Meaning |
|---|---|
| `date` | Payout day. Default: tomorrow (EAT), rolled past Sat/Sun, so the Fri, Sat and Sun emails all plan **Monday** |
| `from`, `days` | First due date covered = day after the previous weekday. Monday → Sat–Mon (3 days); Tue–Fri → 1 day |
| `roi.items[].due_date`, `roi.by_day[]` | Cash vs compounding per due date |
| `roi.cash_total` | Cash Returns only. **Compounding is never cash**; it's listed separately |
| `plan.base_total` | Returns cash + landlord queue + wallet withdrawals + partner capital |
| `plan.cushion` / `plan.total` | `p_cushion_pct`% of base (default 10, 0 hides it) / base + cushion |
| `backlog.roi_past_due` | Now "due before `from`", so it never overlaps the range |

The email (`daily-payout-projection-report`) shows the range in the subject and header
("Returns due Sat 26 Sep – Mon 28 Sep"), a per-day Returns table, a Due column per
supporter, and **Cushion** + **HAVE READY** lines. The CSV's first column is the due date.
Executives can override `date`, `from`, `cushion_pct`, `to`, `cc` and `dry_run`.
`useNextDayPayoutProjection(date?, cushionPct = 10)` has the new types. No UI panel
consumes it yet (Gemini's lane).

## Monday 28 Sep, from live data (read 2026-09-26 by another session)
| | UGX |
|---|---|
| Returns cash, Sat 26 (15) + Sun 27 (30) + Mon 28 (47) | 120,188,732 |
| Landlord 4,950,000 + withdrawals 92,000 + partner capital 1,743,900 | 6,785,900 |
| **Base** | **126,974,632** |
| Cushion 10% | ~12,697,463 |
| **Have ready** | **~139.7M** |
| Compounding, not cash (33 portfolios) | 35,068,544 |

## Things to watch when using the number
- **Wallet withdrawals overlap Returns.** Returns are credited to wallets and leave as
  withdrawals. Completed withdrawals averaged ~55.4M per weekday (peak 134.9M) over two
  weeks, including cashed-out Returns. Size the cushion for non-Returns withdrawals only.
- The withdrawal queue fills over the weekend. The Sunday 18:00 figure is the one to plan on.
- The past-due Returns backlog (52 portfolios, ~9.5M) is counts only. Add it if it'll
  be paid Monday too.
- Public holidays aren't known. For a Tuesday after a Monday holiday, an executive
  passes `from` explicitly.

## Verify after applying
```sql
select (r->>'date') d, (r->>'from') f, r->'roi'->'by_day' by_day, r->'plan' plan
from (select public.get_next_day_payout_projection() r) x;  -- as service role
```
Expect on a weekend: `date` = Monday, `from` = Saturday, three `by_day` rows.
