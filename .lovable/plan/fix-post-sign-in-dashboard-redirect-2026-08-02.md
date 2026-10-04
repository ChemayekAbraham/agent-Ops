# Fix post-sign-in dashboard redirect

## What is happening

After a successful sign-in, `src/pages/Auth.tsx` sends the user to
`roleToSlug(authRoles[0])` — the **first role row returned from the database**,
in whatever order Postgres happens to return it. Sampled role rows show that
order is not stable across users:

```text
user A -> {tenant, supporter, landlord, agent}   -> lands on /dashboard/tenant
user B -> {supporter, ...}                        -> lands on /dashboard/funder
```

So whether a signing-in user lands on the tenant dashboard or the funder
dashboard is effectively arbitrary. This path also ignores every routing rule
the app already has:

- the admin-set `forced_default_role` on the profile
- the user's own "Home screen" preference (device + server-synced)
- the last role they used
- the merchant/cash-out agent rule

All of that logic already exists and is centralised in `DashboardRedirect`
(the `/dashboard` route) and in `roleManager`, but the sign-in screen bypasses
it entirely.

A second, smaller contributor: when a user has no explicit choice at all, the
role resolver falls back to `userRoles[0]` (same unstable order), and its
hard error fallback is `supporter`.

## The fix

1. **Sign-in redirect goes through the central resolver.** In `Auth.tsx`,
   replace the `roleToSlug(authRoles[0])` navigation with a navigation to
   `/dashboard`, letting `DashboardRedirect` decide the persona using the
   existing priority chain (explicit `?redirect` and stored redirect handling
   stays exactly as it is and still wins).

2. **Make the "no preference" fallback deterministic and tenant-first.** In
   `roleManager`, when there is no forced default, no device preference, no
   last-used role and no intended role, pick the first role the user holds from
   a fixed priority order that starts with `tenant` (tenant → agent → landlord
   → supporter) instead of the raw database order. The cash-out agent rule and
   all explicit choices keep their current precedence.

3. **Change the hard-failure default from `supporter` to `tenant`** so a role
   fetch error can never drop a user on the funder dashboard.

Net effect: a signing-in user lands on the tenant dashboard unless they (or an
admin) explicitly chose otherwise, or they are an active merchant agent.

## Files touched

- `src/pages/Auth.tsx` — post-auth navigation target only.
- `src/hooks/auth/roleManager.ts` — deterministic tenant-first fallback ordering
  and default-role constant.

No database, RLS, or schema changes. No change to role switching, to the role
picker, or to deep links that already carry a `?redirect` or a persona slug.
