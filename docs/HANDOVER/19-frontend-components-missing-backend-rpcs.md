# 19. Fix — five frontend components calling nonexistent RPCs (2026-09-14)

**Status: all five fixed, verified live, committed/pushed one at a time.**

---

## How these were found

Not a code review — a systematic cross-reference. Extracted every unique RPC name (656) and edge
function name (171) called anywhere in `src/` via a single grep pass, then checked each against
what actually exists live in the database (`pg_proc`) and in `supabase/functions/`. This is worth
re-running periodically — it costs one grep pass plus one SQL anti-join, and it is the only way
this kind of gap reliably surfaces (nothing errors loudly; the component just spins, shows a blank
`—`, or silently never updates).

```bash
grep -rohE "\.rpc\(\s*['\"][a-zA-Z0-9_]+['\"]" src/ | sed -E "s/.*\.rpc\(\s*['\"]([a-zA-Z0-9_]+)['\"].*/\1/" | sort -u
grep -rohE "functions\.invoke\(\s*['\"][a-zA-Z0-9_-]+['\"]" src/ | sed -E "s/.*invoke\(\s*['\"]([a-zA-Z0-9_-]+)['\"].*/\1/" | sort -u
```
Then anti-join each list against `pg_proc` / `supabase/functions/*` directories.

---

## The five gaps, and what each turned out to need

| Component / hook | Called | Real gap | Fix |
|---|---|---|---|
| `FinancialOpsCommandCenter.tsx` (sidebar badge + FinOps home count) | `get_stale_withdrawal_hold_count` | Never existed. A near-identical `get_stale_withdrawal_hold_queue` did — this was the count-only variant that was never built alongside it. | New RPC mirroring the queue RPC's exact thresholds/filter, same auth gate (`is_withdrawal_hold_reviewer`). |
| `WelileHomesSubscriptionsManager.tsx` ("Apply Interest" button) | edge function `apply-welile-homes-interest` | Function never existed. The real logic (`apply_welile_homes_monthly_interest`) already existed as an RPC — this was a wiring mistake, not missing logic. | Pointed the frontend at the RPC directly, fixed result handling (plain `integer`, not `{updated_count}`). **Also found the RPC had zero auth check and was `anon`-executable** — see [`14-anon-executable-apply-welile-homes-interest.md`](./14-anon-executable-apply-welile-homes-interest.md), the more serious finding from this same fix. |
| `AutoCreditSuccessRateTile.tsx` (Financial Ops dashboard, mounted and visible) | `get_deposit_autocredit_success_rate` | Never existed. The tile's own code comment already anticipated this ("a migration hasn't been applied yet"), so it degraded to a blank `—` instead of crashing — but the number shown was never real. | New RPC using the *exact same candidate-selection filter* as `auto_create_deposits_from_gmail_impl` (parsed, inbound direction, positive amount, non-empty transaction_id, within window) — not an invented metric. |
| `useTenantEngagementReport.ts` | `get_tenant_engagement_report` | Never existed. **Zero call sites anywhere in `src/`** — built ahead of any UI that uses it. Dead but harmless until something renders it. | Built from the hook's own docstring spec (cross-reference `has_smartphone` with `last_active_at` — the 2026-09-06 tenant-ops meeting gap). Same auth gate as the rest of Tenant Ops (`is_tenant_ops_staff`). |
| `LedgerHealthPanel.tsx` | `exec_sql` | Not a real RPC, never was. Dead leftover — the very next lines already do a direct `supabase.from('general_ledger')` query and only that result feeds the component; the broken call's error was never even checked. | Deleted the stray call. No backend change needed. |

---

## Verification pattern used for each (not just "it compiles")

For every new/fixed RPC: called it directly against production and independently cross-checked
the number against a manual query using the identical filter, e.g.:

```sql
-- example: auto-credit success rate
select get_deposit_autocredit_success_rate(24);
select count(*), count(*) filter (where linked_deposit_request_id is not null)
from gmail_transactions
where parsed=true and direction in ('in','credit') and amount>0
  and transaction_id is not null and length(trim(transaction_id))>0
  and internal_date >= now() - interval '24 hours';
-- both must agree
```

Confirmed: 31 attempted / 29 successful (93.5%) — matched exactly. Similar independent
cross-checks were run for the stale-hold count (0 vs 0) and the tenant-engagement summary (95,815
tenants / 95,710 with smartphone / 0 never active / 55,820 inactive 30d+, matched exactly).

---

## What not to do

- Don't assume a component rendering without a visible error means its data is real. `.catch`-free
  degraded states (a blank `—`, a spinner that never resolves) are silent by design in several of
  these components — they were built that way deliberately for the "migration hasn't landed yet"
  case, which is exactly what makes them easy to miss.
- Don't fix a wiring mismatch (frontend calls X, backend has Y) by assuming the simplest
  explanation. The `apply_welile_homes_monthly_interest` case shows why: fixing the wiring
  surfaced a real, unrelated authorization gap that had nothing to do with the original bug.
