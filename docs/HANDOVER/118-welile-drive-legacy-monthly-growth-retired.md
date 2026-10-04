# 118 — Welile Drive: legacy "Run monthly growth" retired (double 5% credit)

**Applied live 2026-09-24 to the Welile Drive database (separate Lovable project
`f77edb20-daa4-468c-b8e0-98d5d6af3565`, NOT this repo's DB). Before re-enabling any manual growth
run in Welile Drive, or if a Drive admin reports the growth button now errors.**

## What was reported

Lovable flagged it at 05:50 on 2026-09-24. The old admin "Run monthly growth" button still ran
alongside the new automatic 5% monthly growth, so one staff click credited every saver 5% twice in
the same month.

## What was found

Welile Drive has two independent growth engines that post to the same ledger:

| Path | Trigger | Idempotency key |
|---|---|---|
| `accrue_savings_growth()` (automatic) | `getDashboard`, the savings listing and one more server fn in `src/lib/welile.functions.ts`, called via the service-role `adminDb()` | `growth-cycle:<wallet>:<n>` (n = monthly anniversary of the first deposit) |
| `run_monthly_growth(p_period)` (legacy) | `triggerGrowthRun` server fn (admin/finance) → admin Growth page button | `growth:<wallet>:<YYYY-MM>` plus a `growth_runs` row |

`post_ledger_transaction` dedupes only on an exact key match, and the two namespaces never match,
so each engine saw its own credits and not the other's. The report's claim was correct.

A second exposure: `accrue_savings_growth` was executable by `anon` and `authenticated`, so anyone
with the public key could trigger it. It is idempotent, so the harm was limited, but it's still a
money-posting function.

**No double credit had happened yet.** `growth_runs` was empty, and the only growth postings were
2 automatic `growth-cycle` credits (2026-09-10) across 4 funded savers.

## What was done (Drive DB, via query_database)

- `run_monthly_growth(text)` now always raises `feature_not_supported`: "Manual monthly growth is
  retired … No wallets were credited." The signature and default are unchanged, so the server fn
  compiles and the button surfaces the error instead of crediting anything.
- `REVOKE EXECUTE ON accrue_savings_growth() FROM PUBLIC, anon, authenticated`. The ACL is now
  postgres + service_role only. Every caller uses the service-role `adminDb()`, so automatic growth
  is unaffected.

Verified: calling the retired function raises; the ACL is `{postgres, service_role}`; there are
still 2 growth transactions and 0 growth_runs.

## Not done

- **The button is still visible** on `/admin/growth` (`AdminModulePage module="growth"` →
  `triggerGrowthRun`). Removing it is UI work (Gemini/Lovable). It is now harmless, just noisy.
- **This change is not in the Drive repo's `supabase/migrations/`.** That repo is Lovable-managed
  and couldn't be committed to from here. If anyone rebuilds the Drive DB from its migrations, the
  legacy function comes back live. Ask Lovable to add an equivalent migration.
- If a manual growth tool is ever wanted again, it must post with the **same** `growth-cycle:` key
  scheme (or `accrue_savings_growth` must check both namespaces) before it is re-enabled.
