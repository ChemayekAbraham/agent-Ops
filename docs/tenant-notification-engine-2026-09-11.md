# Tenant Notification Engine — what shipped and how it's held up since

Status: IMPLEMENTED 2026-09-09 (6 commits, Stages 1–6, ~7,000 lines across 19+ files) +
UI surfaces same day. Engine-level dry-run tested and one real end-to-end tenant test run
2026-09-11. **3 defects open, 1 fixed and deployed same day as the build.**

## 0. What this is

12 SMS/push/in-app event types covering a tenant's lifecycle and payment behaviour:
registration → smartphone discovery → dashboard activation → OTP login → payment-behaviour
messaging (missed/full/partial) → agent-opportunity and rent-limit nudges → relocation
notice → merchant-code reminders → device/app-migration push. Every sender shares one
`dry_run: true` simulation path, so any of them can be previewed against live data with
zero real sends and zero DB writes.

## 1. Build timeline (all 2026-09-09, Josh Wanda)

| Commit | Size | What it added |
|---|---|---|
| `363eac185` | 4 files, +879 | Base engine + `FIVE_DAY_AGENT_OPPORTUNITY` |
| `73956f6d3` | 4 files, +832 | `PAYMENT_MISSED` / `PAYMENT_FULL` / `PAYMENT_PARTIAL`, fixed day attribution |
| `2a0a9ec9e` | 9 files, +1398/−85 | Stage 3: `TENANT_RELOCATION`, `RENT_LIMIT_INCREASED`, `RENT_LIMIT_PROGRESS`, `MERCHANT_CODE_REMINDER` |
| `68443afc0` | 7 files, +1182/−19 | Stage 4: smartphone lifecycle, `tenant-dashboard-invites`, `tenant-dashboard-open`, device evidence |
| `5c9d48f6f` | 8 files, +850/−23 | Stage 5: notification attribution + smartphone/SMS analytics RPCs |
| `349c7d39f` | 19 files, +1949/−321 | Stage 6: multi-channel routing (SMS/push/in-app), `tenant-push-migration-notices` |
| `26a8393b0` | 15 files | Gemini's UI surfaces (bell, preferences card, analytics page, call-centre panel) — same day |
| `ecf9be347` | 3 files, +27/−2 | Fixed swallowed error messages in `tenant-notification-attribution` and `tenant-push-migration-notices` — its own commit message calls these "the two functions Lovable never deployed" |

All six build commits are ancestors of `origin/lovable` (current tip `b248a43bf`) —
confirmed via `git merge-base --is-ancestor` on 2026-09-11.

## 2. How it's built (from reading the code, not the commit messages)

- **Message copy lives in the database, not in source.** Every sender calls
  `loadEvent(admin, eventKey)` and renders `event.body_template` — a copy fix is a DB
  row edit, not a deploy. (This also means a repo `grep` can never confirm current wording;
  only a live query can.)
- **`dry_run: true` everywhere.** Every sender in this engine accepts it and returns a
  `preview[]` of rendered messages instead of sending or writing anything.
- **Governor cap.** `marketing`-classed events (dashboard invites, relocation, rent-limit
  nudges) share one global twice-weekly send cap so they compete with each other rather
  than stacking.
- **`tenant-dashboard-invites`** is deliberately public (`verify_jwt = false` in
  `supabase/config.toml`) for its token-redemption path — a signed-out tenant opening
  `welileapp.com/t/{token}`. The same function also serves bulk `mode=discovery` /
  `mode=invite` sends (up to `limit`, default 2000) and a call-centre single-send keyed on
  a raw `tenant_id` — see §3.2, this is a real gap, not just a design note.

## 3. Testing performed this session (2026-09-11)

### 3.1 Engine-level dry-run, all 8 remaining senders (`dry_run: true`, zero real sends, zero writes)

| Sender | Result |
|---|---|
| `PAYMENT_MISSED` | 355 real candidates, correct amounts + merchant codes |
| `PAYMENT_FULL` / `PARTIAL` | 9 candidates, correct "obligation cleared" + balance copy |
| `FIVE_DAY_AGENT_OPPORTUNITY` | 0 candidates today — expected, episode-floor guards working |
| `TENANT_RELOCATION` | 683 active tenants, correct copy |
| `RENT_LIMIT_INCREASED` | 33 real limit increases, correct old→new deltas |
| `RENT_LIMIT_PROGRESS` | 80 candidates, correct copy |
| `MERCHANT_CODE_REMINDER` | 488 candidates, correct MTN/Airtel codes |
| `PUSH_MIGRATION` | ❌ 404 "function not found" — see §4.1 |

### 3.2 Real end-to-end test on one live tenant

Test subject: Brian Kagumba, `0761658253` (same-day signup, chosen because it's a real,
disposable, company-controlled number). Verified for real: registration → smartphone
lifecycle → dashboard link → OTP login → in-app bell/preferences → analytics, all on this
one tenant's actual rows.

Payment-behaviour eligibility was **not** exercised on Brian's own row. Getting there
required a rent request in `funded`/`repaying` status, which live-data checks showed means:
a real `fund-agent-landlord-float` call (UGX 50,000 real company money + UGX 5,000 real
agent bonus + real SMS/email), a settlement to a fictitious "TEST Landlord", and acting
through five role gates (Agent → Agent Ops → Tenant Ops → Landlord Ops → COO → CFO) that
exist specifically to prevent an unchecked disbursement like that. Declined — the payoff
(Brian's own row in a query already proven correct on 539 other real tenants) didn't
justify the cost (real money to a fake landlord, plus exposure while the collection engine
had a live, separate, unresolved bug — see §5).

## 4. Defects found, current status

### 4.1 `tenant-push-migration-notices` — merged, not deployed. OPEN.

Live-fires 404. The function exists in the repo, merged into `origin/lovable` since
`349c7d39f` (2026-09-09), and its own error-swallowing bug was already fixed same day in
`ecf9be347` — whose commit message explicitly names it as one of "the two functions
Lovable never deployed." Merging to the branch and deploying the Supabase edge function
are two separate steps here; the deploy step was never run for this one.

### 4.2 `tenant-dashboard-invites` — no auth check on non-token paths. OPEN, higher severity than filed.

`verify_jwt = false` is intentional for the token-redemption case (signed-out tenant, no
financial data, no session — documented in the function's own header comment). But the
same public endpoint also serves `mode=discovery` / `mode=invite` (bulk sends, up to 2000
tenants per call, no cap enforced beyond that parameter) and a call-centre single-send
keyed on any `tenant_id` string — with no secondary auth, secret, or rate limit anywhere in
the function body. Anyone with the URL can currently trigger a real SMS send to an
arbitrary tenant, or a bulk send to thousands, fully unauthenticated. Needs a check scoped
to the bulk/single-send paths without breaking the legitimate public token path.

### 4.3 OTP error-swallow fix — committed, not pushed. OPEN.

`77a35a6a7` ("Fix swallowed OTP error on tenant dashboard link login") exists locally only.
As of 2026-09-11 the `lovable` branch is 2 commits ahead / 492 behind `origin/lovable` —
this fix has not reached the deployed branch.

### 4.4 PAYMENT_MISSED copy nit — reported fixed, unverified independently this pass.

Template said "Today's UGX X rent payment was not received" while reporting a closed
*prior* day's obligation. Reported fixed live (DB `body_template` edit, re-tested at the
time: "Yesterday's UGX 6,984 rent payment was not received..." across 356 candidates). This
session's Lovable/`welile-rent-hub`/`rentflow-insights` MCP authentication lapsed
afterward (likely a context-compaction side effect) and has not been re-established, so
this fix has not been independently re-confirmed since. Re-check once re-authenticated.

## 5. Adjacent discovery — not part of this engine

While preparing to record a real test payment for §3.2, an intermittent bug in
`agent_allocate_tenant_payment_internal` was found: the agent-float ledger leg
occasionally posts as `cash_in` instead of `cash_out`, inflating agent float and paying
phantom commission on it. Confirmed live: 6 agents, UGX 6,457,236 total inflation, most
recently 06:21 on 2026-09-11. This is a separate subsystem (collections, not
notifications) and is explicitly being handled by Pius — noted here only because it's why
Brian's own payment-behaviour row was deferred rather than tested with fabricated urgency.

## 6. Before calling this fully live

- Deploy `tenant-push-migration-notices` (code and error handling are already correct and
  merged; this is a deploy-only step).
- Add an auth/secret gate to `tenant-dashboard-invites`'s bulk and single-tenant-id paths,
  leaving the token-redemption path public.
- Push `77a35a6a7` to `origin/lovable`.
- Re-authenticate the Lovable/Supabase MCP connection and re-verify the copy-template fix
  and Brian's own `PAYMENT_MISSED`/`PAYMENT_FULL` row once his plan is genuinely funded.
- `FIVE_DAY_AGENT_OPPORTUNITY` and `RENT_LIMIT_INCREASED` remain proven only at
  engine-level (0 and 33 real candidates respectively) — they need multiple real elapsed
  calendar days per tenant to test individually, and backdating timestamps to fake that
  was deliberately ruled out.
