# 45 — CMO growth dashboard counted purged bot accounts as real users

**Read this before touching `CMODashboard.tsx`'s `CMOMarketingDashboard` queries
(`signupTrend`, `referralStats`, `totalUsers`, `recentReferrals`, `topReferrers`), or
before trusting its Total Users / Referral Signups / Conversion Rate tiles.**

## What was found

Josh flagged that the CMO dashboard showed "Total Users: 90,951" for the 2026-04 to
2026-09 range, when the known real figure (repeatedly verified this session against
`profiles`) is ~62k.

Every query in `CMOMarketingDashboard` — `signupTrend` (Monthly Signups), `referralStats`
(Total/Pending/Completed Referrals), `totalUsers` (Total Users), plus the `recentReferrals`
table and `topReferrers` leaderboard — counted straight from `profiles` and `referrals`
with **no `deleted_at` exclusion anywhere**. Verified against production:

- `profiles`: **96,629** rows ever created, **34,386** of them soft-deleted (bot/fraud
  purges — the referral-bonus rings from docs 21, 23, 39, 42, this session's
  `dormant-shell` sweep, etc.), leaving **62,243** real active users.
- `referrals`: **90,261** raw rows, of which **34,339** point at a `referred_id` that is
  now soft-deleted — almost exactly the same count as the deleted profiles, confirming
  these are the same bot rings. **80,554** of all referral rows show `credited = true` —
  the fraud ring's bare-signup exploit reliably triggered bonus credit before that gate
  was fixed (doc 21).
- So "Conversion Rate: 94%" was just `totalReferrals ÷ totalUsers` computed from two
  numbers that were each roughly 1/3 fraudulent — mechanically correct, meaningless input.

This is the same class of problem as doc 29 (CTO Report/Board Memo fabrications), just
never audited on the CMO's growth dashboard specifically.

## What was fixed

All five queries in `CMODashboard.tsx` now exclude soft-deleted accounts:

- `signupTrend` and `totalUsers` (both query `profiles` directly): added
  `.is('deleted_at', null)`.
- `referralStats`, `recentReferrals`, `topReferrers` (all query `referrals`): added an
  embedded inner join on the referred profile —
  `referred:profiles!referrals_referred_id_fkey!inner(deleted_at)` with
  `.is('referred.deleted_at', null)` — since `deleted_at` lives on `profiles`, not
  `referrals`, and a referral row itself is never deleted when its referred profile gets
  soft-deleted (`ON DELETE CASCADE` only fires on a hard delete, which this codebase never
  does — see doc 21 "What not to do").

Verified against production with the same date range as the screenshot (2026-04-01 to
2026-09-30): real numbers are **Total Users 56,566**, **Total Referrals 50,797**,
**Completed Referrals 44,939** — down from the fabricated 90,951 / 85,136 / 79,265.

## What was deliberately left alone

- `GrowthMetricsView.tsx`'s own "Total Users" tile (a *different* CMO tab, reached via
  `activeTab === 'growth'`) reads `daily_platform_stats.total_users`, a precomputed
  snapshot table populated elsewhere. Not touched in this pass — the screenshot that
  started this was the default `CMOMarketingDashboard` view, not the Growth tab. If that
  snapshot table has the same problem, it needs its own investigation into whatever
  populates it.
- No backfill of `referrals` itself — the fraud-ring rows still exist in that table (per
  the standing "never delete ledger/reference history" rule), they're just now correctly
  excluded from these specific growth-reporting queries via the join.

## Verify this is still fixed

```sql
-- Should match what the dashboard shows for the same range, give or take signupSource filtering.
select
  (select count(*) from public.profiles where deleted_at is null
     and created_at >= '2026-04-01' and created_at <= '2026-09-30') as total_users,
  (select count(*) from public.referrals r join public.profiles p on p.id = r.referred_id
     where p.deleted_at is null and r.created_at >= '2026-04-01' and r.created_at <= '2026-09-30') as total_referrals;
```

## What not to do

- Don't remove the `!inner` join hint from the embedded `referred:profiles(...)` selector
  — without it, PostgREST does a left join and the `deleted_at` filter silently stops
  filtering anything.
- Don't assume this fix covers every executive dashboard's growth numbers — this pass
  only touched `CMODashboard.tsx`'s default view. Other dashboards (CEO, COO, manager) may
  have the identical raw-count-without-`deleted_at` pattern and haven't been audited here.
