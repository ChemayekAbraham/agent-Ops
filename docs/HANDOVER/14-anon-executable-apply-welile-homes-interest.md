# 14. Incident — `apply_welile_homes_monthly_interest` had zero auth check (2026-09-14)

**Severity: High. Fixed and verified live.** Not a hypothetical — this was reachable by an
unauthenticated request the whole time it existed.

---

## The one-sentence cause

`WelileHomesSubscriptionsManager`'s "Apply Interest" button called
`supabase.functions.invoke('apply-welile-homes-interest')` — an edge function that **does not
exist and never did**. Every click failed silently. The real logic already lived in the Postgres
RPC `apply_welile_homes_monthly_interest()`, which was never wired to any frontend caller — and,
independently, had **no authorization check in its body at all**.

---

## What that gap actually meant

The page that hosts this button (`ManagerAccess.tsx`) is gated **client-side only** to
`role === 'manager'` — a route guard, not a security boundary. The RPC itself had:

```sql
-- before the fix: no role check anywhere in the function body
create or replace function apply_welile_homes_monthly_interest() ...
```

and its `EXECUTE` grant included `anon` and `authenticated` (Supabase's default broad grant,
never revoked here — unlike almost every other RPC in this codebase, which enforces its own
`has_role(...)` check regardless of what PostgREST grants exist). That combination means: **any
signed-in user, or an unauthenticated request straight against the REST endpoint, could compound
5% interest across every active, landlord-registered Welile Homes subscription's `total_savings`
on demand** — bypassing the manager-only page entirely.

This was found while fixing the *unrelated* wiring bug (nonexistent edge function) — the auth gap
was not what anyone was looking for.

---

## The fix

1. Added a role check to the RPC body itself — `manager`, `cfo`, or `super_admin` — matching the
   pattern used elsewhere in this codebase for manager-triggered financial batch actions. The RPC
   now raises `Not authorized to apply Welile Homes interest.` for anyone else.
2. `REVOKE ALL ... FROM PUBLIC, anon` — `anon` no longer has `EXECUTE` at all.
3. Wired the frontend to call the RPC directly via `.rpc('apply_welile_homes_monthly_interest')`
   instead of the nonexistent edge function, and fixed the result handling — the RPC returns a
   plain `integer` (the updated row count), not an `{ updated_count }` object as the old code
   assumed.

Migration: `20260914101000_gate_apply_welile_homes_monthly_interest.sql`.

---

## Verify this is still fixed

```sql
select grantee from information_schema.routine_privileges
where routine_name = 'apply_welile_homes_monthly_interest'; -- expect NO 'anon' row

select pg_get_functiondef(oid) ilike '%has_role%'
from pg_proc where proname = 'apply_welile_homes_monthly_interest'; -- expect true
```

If either check fails, the RPC has drifted back to its unprotected state — re-apply the migration
immediately, this is a real money-adjacent write with no other gate in front of it. (This function
is a strong candidate to add to the drift-detection baseline in
[`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md) if it isn't
there already — check `select * from critical_function_baselines where function_signature =
'apply_welile_homes_monthly_interest()'`.)

---

## What not to do

- Do not assume a manager-only *page* means a manager-only *RPC*. Every RPC callable from the
  client needs its own `auth.uid()` / `has_role(...)` check in its body — a route guard is UI
  polish, not access control.
- Do not trust `EXECUTE` grants as the access-control layer in this codebase. The convention here
  is broad default grants (`anon`, `authenticated`, `PUBLIC` all present on most functions) with
  the real gate inside the function body. A function missing that internal check is broken
  regardless of what its grants say — and a function that *has* the check doesn't strictly need
  `anon`/`PUBLIC` revoked, but revoking them is cheap defense in depth once you're already fixing
  the real gap.
