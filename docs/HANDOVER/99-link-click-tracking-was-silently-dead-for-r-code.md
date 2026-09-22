# 99 — Link click tracking was silently dead for `/r/:code`; added platform-wide performance RPC

**Fixed live 2026-09-21.** Before touching `ResolveRLink.tsx`, `record_short_link_click`, or assuming a
`short_links.click_count` of 0 means nobody clicked — check which route generated the link first.

## What was asked

Josh: "once we send a message with a link we should be able to track the results of how many
interacted with that link" — platform-wide (SMS + email + all campaigns), aggregate click counts
per link/campaign.

## What was actually broken

Two separate frontend routes resolve short codes, and only one of them tracks clicks:

- `/s/:code` and the catch-all `/:code` → `TrackedRedirect.tsx` — resolves via `resolve_short_link`,
  then correctly calls `record_short_link_click` (fire-and-forget) before redirecting.
- `/r/:code` → `ResolveRLink.tsx` — resolved via the same `resolve_short_link` RPC, but **never**
  called `record_short_link_click`. It just redirected.

The catch is that `/r/:code` is the *only* prefix the app ever generates: both `createShortLink.ts`
and the `useShortLink` hook hardcode `${origin}/r/${code}`. So essentially every short link ever
created by the app — auth invites, activation, funder-onboarding, landlord-signup, partner
registration, merchant registration, tenant registration, rent-plan shares, house-support shares —
pointed at the untracked route. `record_short_link_click` existed, was correctly grantable to
`anon`/`authenticated`, and was simply never invoked on the path real traffic uses.

Confirmed live before the fix (`short_links`, `resource_type is null`, grouped by `target_path`):

| target_path | links created | recorded clicks |
|---|---|---|
| `/activate` | 259 | 0 |
| `/funder-onboarding` | 231 | 0 |
| `/landlord-signup` | 124 | 0 |
| `/limit` | 25 | 0 |
| `/register-partner` | 23 | 0 |
| `/merchant/register` | 14 | 0 |
| `/register-tenant` | 13 | 0 |
| `/agent-commission-benefits` | 7 | 0 |
| `/auth` | 2,161 | 732 (all via the 4 links that happened to be shared as bare codes, hitting the catch-all `/:code` route instead) |
| `/join` | 1 | 180 (recruitment link, different system — see below) |

## Fix

Added the same `record_short_link_click` call to `ResolveRLink.tsx`'s redirect branch, mirroring
`TrackedRedirect.tsx` exactly (fire-and-forget, `navigator.userAgent` / `document.referrer`, wrapped
in try/catch so a tracking failure never blocks the redirect). No RPC/table changes needed — the
recording infrastructure was already correct, just unreached.

**Numbers for the `short_link` channel from before 2026-09-21 undercount real clicks** for every
link created via `createShortLink.ts`/`useShortLink.ts` — don't treat historical zeros as "nobody
clicked."

## Also built: unified reporting RPC

The platform actually has **four independent click-tracking systems**, none surfaced anywhere:

| Channel | Tables | Notes |
|---|---|---|
| Generic shortener | `short_links` / `short_link_clicks` | Just fixed above. Covers auth/activation/onboarding/registration links. |
| Agent recruitment | `recruitment_campaign_links` / `recruitment_campaign_clicks` | The `welileapp.com/join/{code}` links riding inside tenant PAYMENT_FULL/PARTIAL SMS via `get_tenant_status_appendices`. Already worked correctly — `converted_to_registration` flag included. |
| Career page | `career_link_clicks` | UTM-keyed landing hits, no parent link row. |
| Tenant dashboard | `tenant_dashboard_links` | Per-tenant, per-notification link (`notification_log_id`, `use_count`), used by `tenant-dashboard-invites` (`discovery`/`invite`) and a `call_centre` purpose. Live with real data (184 rows) — the "Stage 4C, doesn't exist yet" comment in `tenantTemplates.ts` (`dashboardSuffix()`) is stale for *this* system; it's just not wired into the payment/rent-limit SMS templates, which is a separate, smaller gap than what was asked here.

Added `get_link_performance_summary(p_since timestamptz default now() - interval '30 days')`
(migration `20260921120000_link_performance_summary.sql`, applied live) — one role-gated RPC
(`super_admin`/`manager`/`operations`/`coo`/`cfo`/`ceo`/`cto`/`cmo`) that unions all four channels
grouped by a natural key (`target_path`/`resource_type` for short links, campaign name for
recruitment, UTM campaign for career, `purpose` for tenant dashboard links), returning
`links_created`, `total_clicks`, `links_with_clicks`, `conversions`, `last_click_at`. Verified live
against 90 days of production data — output matches the manual per-table queries done first,
including the post-fix `/join` (180 clicks, 1 link) and the now-correctly-zero rows for
`/funder-onboarding`/`/activate`/etc. that will start moving now that the `/r/:code` fix is live.

## Explicitly not done

- **Email has zero click tracking anywhere** — no click-wrapping, no Resend/Mailgun webhook handler
  for opens or clicks. `send-transactional-email` sends raw links. Wiring email into this same
  reporting surface is a real follow-up, not a small addition (needs either link-rewriting at send
  time or a webhook handler + a new events table) — flagging rather than guessing at scope.
- **No UI** — this RPC has no dashboard yet. Building the page that calls it is Gemini's lane per
  the division of labor; this doc's job is to hand off a correct, verified data layer.
- **Did not merge the four systems into one table.** They track genuinely different things
  (shared campaign links vs. per-tenant-per-message links vs. UTM-only landing hits) and forcing one
  schema now would lose that. The summary RPC unifies the *read*, not the underlying storage.
- **Deploy status of the frontend fix**: per doc 79, GitHub Actions edge-function deploy has been
  broken (missing `SUPABASE_ACCESS_TOKEN`) — but `ResolveRLink.tsx` is a *frontend* route change, not
  an edge function, so it ships through the normal Lovable/frontend build, not that blocked pipeline.
  Not independently re-verified live in this pass beyond the code diff.
