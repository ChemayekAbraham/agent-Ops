# 22 — Signup entry points: what's guarded, what isn't, and the fix for `submit-tenant-form`

**Read this before adding a new way to create an account, or before trusting that
"there's a guard on signup" means every entry point has one — they don't share one.**

## Context

After remediating the referral-bonus bot-signup ring (`21-referral-bonus-bot-signup-fraud-ring.md`),
Josh asked how to stop it happening again, specifically suspecting the tenant/rent-request
registration flow ("post a rent request") as an entry point. That flow was **not** the
vector for the incident already fixed (every one of the 34,311 remediated bot accounts
used a `@gmail.com` address; the tenant-registration paths below always use a synthetic
`@noapp.welile.user` / `@welile.agent` address, and none of those showed up in the
cleanup). But auditing it anyway surfaced a real, separate, still-open hole.

## The three ways a new account gets created, and their guards

| Entry point | Auth required? | Anti-bot guard | Notes |
|---|---|---|---|
| General signup (`useAuthForm.ts` → `supabase.auth.signUp()`) | No | `preflightSignup()` / `record_signup_attempt` (client-side only — **bypassable** by calling Supabase Auth's public `/auth/v1/signup` REST endpoint directly) **+** the DB-trigger signup-velocity guard added in `20260914150000` (15+ signups/hour from the same `referrer_id`, enforced in `handle_new_user()` — cannot be bypassed by skipping the client, since it fires on the `auth.users` row regardless of how it was inserted) | This was the actual vector for the 24-referrer fraud ring. |
| `register-tenant` edge function (agent-assisted, in-app "register a tenant" form) | **Yes** — requires a real staff/agent JWT | `guardAgentAssistedSignup()` / `record_agent_assisted_signup`: 5 signups/hour, 15/day, keyed by device fingerprint or (if none supplied) the calling agent's own `user_id` | Already had a real server-side cap before this pass. Accepts an arbitrary `email` in the request body, which is why it's flagged here even though it wasn't the exploited path this time. |
| **`submit-tenant-form` edge function (public "self-fill this form" link agents hand out for a rent request)** | **No** — only a shareable `token` + `agent_id` gate it, no login | **None, until this fix.** | This is the "post a rent request" flow Josh suspected. |

## What was wrong with `submit-tenant-form`

- It's a genuinely public, unauthenticated endpoint (`src/pages/RegisterTenantPublic.tsx`)
  — an agent generates a link with a token, hands it to someone (by design, meant for a
  real tenant to self-fill their own details remotely).
- `agent_form_tokens.max_uses` defaults to **50**, `expires_at` defaults to **72 hours**.
  That's the *only* throttle that existed. A script holding one valid token could submit
  50 fake tenants — each creating an `auth.users` row, a `profiles` row with all four
  personas granted, a fake `landlords` row, a fake `rent_requests` row, and a `referrals`
  row (which is exactly what feeds `try_credit_qualified_referrals` for the referral
  bonus) — in well under a minute. Nothing checked IP, device, or request rate.
- Unlike `register-tenant`, it never called `guardAgentAssistedSignup()` at all.

This wasn't invented speculation — it's the same shape of hole as the incident already
fixed, just on a different door. It hadn't been exploited yet (confirmed: zero of the
34,311 remediated bot accounts used this path's synthetic email pattern), but it was
sitting open.

## The fix

`supabase/functions/submit-tenant-form/index.ts` now calls the same
`guardAgentAssistedSignup()` / `record_agent_assisted_signup` RPC that `register-tenant`
already used, keyed on the token's own `agent_id` (already validated against the token
before this runs — there's no logged-in actor to key on since the endpoint is
unauthenticated by design). Same cap: **5 new tenants/hour, 15/day**, on top of the
existing `max_uses`/`expires_at` limits on the token itself. A blocked attempt now
returns a 429 with a clear message instead of silently succeeding.

No database migration was needed — this is edge-function-only code, deployed on push.

## What's still open

- **The general public signup form is still only client-guarded against a script that
  skips the client entirely.** The DB-trigger velocity guard added in `20260914150000`
  closes the specific "one referrer, many signups" shape of abuse, but a bot ring with
  no `referrer_id` at all, or spread thin across many low-volume referrer identities,
  would not trip it. The complete fix for that is a CAPTCHA/Turnstile gate on Supabase
  Auth's own signup endpoint (configured in the Supabase dashboard's Auth → Attack
  Protection settings) — this cannot be done from application code and has not been
  done.
- **`register-tenant` accepts an arbitrary `email` from the request body.** Its 5/hour,
  15/day cap is real and would have blocked the volume seen in the incident already
  fixed, but it's worth knowing this path *can* produce a Gmail-pattern fake account too,
  just at a much slower, capped rate.
- **Both agent-assisted paths' burst cap falls back to keying on the actor (agent) when
  no device fingerprint is supplied.** A script that authenticates as *many different*
  low-volume agent accounts (rather than one high-volume one) would stay under each
  individual actor's cap while still producing meaningful aggregate volume. Neither
  path currently sums across actors from the same IP/device.

## Verify this is still fixed

```sql
-- Should show the guard is being exercised (some rows may be status='allowed', that's fine —
-- what matters is rows exist and status='blocked_burst_hour'/'blocked_burst_day' appear
-- if someone actually hits the cap).
select status, count(*) from public.signup_attempts
where utm_medium = 'agent_assisted' and created_at > now() - interval '7 days'
group by status;
```

```ts
// supabase/functions/submit-tenant-form/index.ts should import and call guardAgentAssistedSignup
// before supabaseAdmin.auth.admin.createUser(...) in the "create new tenant" branch.
```

## What not to do

- Don't raise `agent_form_tokens.max_uses` as a "fix" for a legitimate agent complaining
  about the rate limit — the max_uses cap and the new per-hour/per-day cap are
  independent; raising one doesn't touch the other, and the point of the new cap is
  specifically that a token being valid should not by itself allow unlimited-speed use.
- Don't assume "signup is guarded" means every account-creation code path shares one
  guard. Check each `auth.admin.createUser()` / `auth.signUp()` call site individually —
  see `grep -rn "createUser\|auth.signUp" supabase/functions src` for the current list.
