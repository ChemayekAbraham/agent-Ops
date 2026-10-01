# 180 — Auth init: cap the wait on the account-access guard

## Status
**BUILT 2026-10-01, not yet deployed.** Frontend only (`src/hooks/useAuth.tsx`). No migration, no edge function. Not reproduced; reasoned from code plus live timings.

## Symptom
CTO report 2026-09-30: `auth.init.timeout_forced` 171 events / 84 users in 24h (live `login_phase_events`), the widest user impact in the auth section.

## Cause
`initializeAuth` ran strictly in sequence: `getSession()` → `await enforceAccountAccess()` → `setUser`/`setSession` → roles (up to 5 s more). An 8 s watchdog flips `loading` off regardless. If the chain overruns it, `loading` is false while `user` is still null and `Dashboard.tsx` treats that as "not signed in" and sends the person to `/auth`.

Live timings, last 24 h (`login_phase_events`):
| Phase | n | p50 | p95 | p99 |
|---|---|---|---|---|
| `auth.getSession.end` | 2,568 | 1.5 s | 4.5 s | 24 s |
| `auth.enforceAccountAccess.end` | 9,775 | 0.8 s | 3.4 s | 16 s |
| `auth.roles.early_fetch.await.end` | 2,384 | 0.25 s | 1.7 s | 5.0 s |

p95 getSession + p95 guard is already about 8 s. The report's "2 s average, 47 min max" for the guard was dominated by backgrounded tabs; p50 is 0.8 s. The other call site of the guard (`SIGNED_IN` handler, `useAuth.tsx` ~line 209) already runs it non-blocking.

## Change
Init waits on the guard for at most `ENFORCE_ACCOUNT_ACCESS_WAIT_MS` (2.5 s), then proceeds. The guard keeps running; if it denies it still signs out, clears storage and redirects to `/auth` itself (unchanged), and on error it already failed open. When the cap wins, `auth.enforceAccountAccess.wait_capped` is logged (warn).

## Security note
During the cap window a fraud-blocked user's UI can hydrate for up to the remaining guard time before the redirect. Money movement is gated server-side (RPCs, RLS), not by this client check, and the `SIGNED_IN` path already behaves this way. Frozen accounts are unaffected (they are shown the freeze screen, not signed out).

## Verify after deploy
- `auth.init.timeout_forced` per day should fall from ~170; count `auth.enforceAccountAccess.wait_capped` to see how often the cap fires.
- `fraud_blocked` outcomes of `auth.enforceAccountAccess.end` should still occur and still end on `/auth`.
- If timeouts persist, the next suspect is `getSession` itself (p99 24 s, refresh-lock waits in backgrounded tabs), not the guard.

## Not done
No change to getSession handling, the 8 s watchdog, or the role fetch.

## Architecture map
No update: sequencing inside an existing hook.
