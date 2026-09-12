# Why "Dashboard not available" shows after a fresh sign-in

## What the screen actually means

That message is not a statement about the account's real roles. It is shown only
when the app, at that exact moment, is holding an **empty** role list and the
dashboard router bounces the user to the role picker with reason `no-roles`.
So the question is: why is the in-memory role list empty for a user whose roles
exist in the database?

Confirmed by reading the code and the live database:

- The database read policy on roles allows a signed-in user to read their own
  rows, so a normal read is not blocked.
- Of 314,852 role rows, only 399 rows (145 users) are switched off. So "all
  roles disabled" explains at most a handful of accounts, not a general
  after-sign-in problem.
- The role loader (`src/hooks/auth/roleManager.ts`) empties the role list in
  three situations, and two of them are transient rather than real:
  1. its `auth.getUser()` check fails (token still refreshing right after
     sign-in, a brief network blip) — it then sets roles to empty;
  2. the profile row cannot be read at that instant — it treats the account as
     deleted and sets roles to empty;
  3. every role row is genuinely switched off — the only case where empty is
     correct.
- The dashboard router (`src/pages/DashboardRedirect.tsx`) reacts the instant
  loading turns off, with no grace period: sign-out already emptied the list,
  role loading is capped at 5 seconds, and if it hasn't produced roles yet the
  router sees empty and redirects to the picker.

So a fresh sign-in that hits a slow or flaky first request lands on the role
picker even though the account has tenant/agent/landlord/supporter.

This diagnosis is based on code and schema reads. Which of the two transient
paths fires for a given user is not yet confirmed from a live session, so step 1
below verifies it.

## The fix

1. **Confirm the trigger.** Add temporary sign-in diagnostics (existing login
   telemetry) that record which branch emptied the role list, then reproduce a
   fresh sign-in.

2. **Stop treating "couldn't check" as "has nothing".** In the role loader,
   distinguish an unknown/failed lookup from a confirmed empty result:
   - a failed identity check or unreadable profile keeps the previous roles and
     marks the result as unresolved, then retries once with a short backoff;
   - only an explicit database answer of "all roles off" empties the list.

3. **Give the dashboard router a grace period.** Before sending anyone to the
   role picker for having no roles, require a *resolved* empty result (or a
   short wait plus one retry). A still-loading or unresolved state shows the
   normal loading screen instead of the picker.

4. **Keep the genuine case working.** A user whose roles really are all switched
   off still reaches the picker with the same message.

## Technical notes

- `src/hooks/auth/roleManager.ts` — return a resolution status alongside roles;
  retry once on identity/profile lookup failure; never blank roles on error.
- `src/hooks/useAuth.tsx` — carry the status (`rolesResolved`) through auth
  context; do not blank roles on transient failures.
- `src/pages/DashboardRedirect.tsx` — gate the `no-roles` redirect on
  `rolesResolved`.
- No database, policy, or role-data changes. No change to role switching, the
  picker UI, or any dashboard routing rule other than the empty-roles bounce.
