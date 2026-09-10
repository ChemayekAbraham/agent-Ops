# 1. Ownership, Access and the Bus Factor

The single largest risk to this platform is not a bug. It is that the accounts which control it
are held personally by one or two people. Code can be rebuilt from git. A Supabase project whose
only owner is unreachable cannot.

**Action for the founder before departure:** fill in every `FILL IN` below, add a second
owner/admin to every row in the Critical accounts table, and store the credentials in a company
password manager that at least two current staff can open. Do not leave this file as the only
copy — it is in git, so it must never contain a secret value.

> **This file must never contain passwords, API keys, tokens, or `.env` contents.** It records
> *where* things live and *who* controls them. Values belong in the password manager.

---

## Critical accounts — the things that cannot be rebuilt

Losing access to any of these is an existential event, in roughly descending severity.

| # | Asset | Identifier | Owner today | Second owner? | Recovery path |
|---|---|---|---|---|---|
| 1 | **Supabase / Lovable Cloud project** (the database — all money, all users) | project ref `wirntoujqoyjobfhyelc` | FILL IN | **REQUIRED** | FILL IN |
| 2 | **Lovable project** (build + deploy pipeline) | `43e6c2e1-18a6-4503-badb-5bb6c23491cc`, workspace `ZvxyWdFk8iGNRBgJKysM` ("Welile's Lovable", pro plan) | FILL IN | **REQUIRED** | Lovable support |
| 3 | **GitHub repository** | `github.com/weliletenants-sys/welilereceipts-com-98bba33b` | org `weliletenants-sys` | FILL IN | GitHub org recovery |
| 4 | **Domain registrar** — `welileapp.com` | FILL IN registrar | FILL IN | **REQUIRED** | Registrar support + WHOIS proof |
| 5 | **DNS** for `welileapp.com`, `api.welileapp.com`, `notify.welile.com` | FILL IN provider | FILL IN | FILL IN | — |
| 6 | **Mailgun** (all transactional email) | domain `notify.welile.com`, US region | FILL IN | FILL IN | — |
| 7 | **Yoola SMS** (primary OTP channel — losing this stops all logins) | FILL IN account | FILL IN | FILL IN | — |
| 8 | **Africa's Talking** (SMS/USSD/voice fallback) | FILL IN | FILL IN | FILL IN | — |
| 9 | **Google Cloud project** (Maps, Gmail API, Drive, Search Console) | FILL IN | FILL IN | FILL IN | — |
| 10 | **Gmail mailbox polled for MoMo receipts** — deposits stop matching without it | FILL IN address | FILL IN | FILL IN | — |
| 11 | **Twilio** (WhatsApp login links) | FILL IN | FILL IN | FILL IN | — |
| 12 | **MTN / Airtel merchant + till accounts** (the actual money rails) | FILL IN | FILL IN | **REQUIRED** | Telco account manager |
| 13 | **Cloudflare** (`infra/share-proxy/worker.js`, `wrangler.toml`) | FILL IN | FILL IN | FILL IN | — |

### Two git remotes — know which one you are pushing to

```
origin    https://github.com/weliletenants-sys/welilereceipts-com-98bba33b   <- the real product
```

`origin` is the production repository. 
**Confirm the remote before every push.** The
default branch is `lovable`, not `main`.

---

## Human contacts — who to call

| Role | Name | Contact | Knows |
|---|---|---|---|
| lead engineer | PIUS SSENKAALI | [pexpert46@gmail.com] | Almost- Everything in this repo about agents operations  |
| co-lead engineer | JOSHUA WANDA | [joshwanda17@gmail.com] |Almost everything in this repo about finances and accounting |
| CFO / finance owner | FILL IN | | Ledger corrections, treasury, payouts |
| Ops lead | FILL IN | | Agents, collections, merchants |
| Telco account manager (MTN) | FILL IN | | Float, till, disbursement rails |
| Telco account manager (Airtel) | FILL IN | | Same |
| Legal / regulatory | FILL IN | | BOU/CMA terminology obligations |

---

## Secrets inventory

Secrets live as **Supabase Edge Function secrets**, per environment (dev and prod hold separate
sets; there is a 100-secret cap per environment). They are not in the repo and not in git. `.env`
is local-only and hands-off — never read, print, commit or paste it.

The names below are referenced by the 342 edge functions. The count is how many functions read
each one, i.e. its blast radius if rotated wrongly.

### Platform — rotating these breaks everything

| Secret | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | 351 | Injected by the platform |
| `SUPABASE_SERVICE_ROLE_KEY` | 349 | **Bypasses all RLS.** Never expose to a browser, never log it |
| `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` | 87 / 2 | Safe in the client |

### Messaging — rotating these stops logins or money notifications

| Secret | Used by | Breaks if lost |
|---|---|---|
| `YOOLA_SMS_API_KEY` | 25 | Primary SMS/OTP — **users cannot log in** |
| `AFRICASTALKING_API_KEY` + `AFRICASTALKING_USERNAME` | 56 | SMS fallback, USSD, voice |
| `LANA_SMS_API_KEY` | 11 | Last-resort SMS |
| `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` + `MAILGUN_API_BASE` | 18 | All email, all reports |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_API_KEY` / `TWILIO_WHATSAPP_FROM` / `TWILIO_WHATSAPP_CONTENT_SID` | 4 | WhatsApp login links |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 2 | Web push. **Rotating invalidates every existing subscription** |
| `INNGEST_API_KEY` | 1 | Background SMS event queue |

### Google

| Secret | Used by | Breaks if lost |
|---|---|---|
| `GOOGLE_MAIL_API_KEY` | 13 | **MoMo deposit matching stops** — deposits sit unmatched |
| `GOOGLE_DRIVE_API_KEY` | 1 | Offsite document vault |
| `GOOGLE_SEARCH_CONSOLE_API_KEY` | 6 | SEO monitoring only |
| `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY` | build | Referrer-restricted; served via `get_maps_browser_key()`. Server-side Maps calls 403 by design |

### Other

`LOVABLE_API_KEY` (33 — AI gateway), `SEMRUSH_API_KEY`, `LINKEDIN_API_KEY`, `OPS_SLACK_WEBHOOK_URL`,
`NFC_CARD_HMAC_SECRET`, `USSD_CALLBACK_SECRET`, `PLATFORM_USER_ID`, `SUPPORT_INBOX_EMAIL`,
`SUPPORT_PHONE`, `CAREERS_FROM`, `CAREERS_REPLY_TO`, `SIGNUP_SHORT_URL`, `PUBLIC_SITE_URL`,
`AT_SENDER_ID`, `AFRICASTALKING_VOICE_NUMBER`, `CRM_CALL_RECORDING`, `ACK_CUTOFF`.

Test-only, must never be set in production: `TEST_PARTNER_ID`, `TEST_AGENT_SUMMARY_ID`,
`OPERATOR_JWT`, `RUN_LIVE_EMAIL`.

### Build-time variables (frontend)

`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
`VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`. Enforced by `scripts/check-runtime-env.mjs`;
a missing one fails the build rather than shipping a broken bundle.

### CI

`SUPABASE_ACCESS_TOKEN` — a GitHub repository secret, used only by
`.github/workflows/deploy-edge-function.yml`.

### Rotation rules

1. Rotate one secret at a time and watch the affected functions before the next.
2. **Never rotate `YOOLA_SMS_API_KEY` and `AFRICASTALKING_API_KEY` in the same window.** If both
   are wrong at once nobody can receive an OTP and nobody can log in — including you.
3. Rotating `VAPID_*` silently kills every push subscription. Plan a re-subscribe prompt.
4. The service role key and database password are inaccessible by design. Do not build anything
   that assumes you can read them back.

---

## Access levels inside the product

Roles live in `user_roles`, never on `profiles`, and are checked through the SECURITY DEFINER
`has_role(uuid, app_role)`. Dashboard access additionally needs a grant in `staff_permissions`.
`super_admin` and `cto` bypass permission checks. See `SYSTEM_CONTEXT.md` §12 for the full matrix.

**Break-glass:** if nobody can reach an executive dashboard, grant `super_admin` in `user_roles`
to a known-good account and record why in `audit_logs`. Do it as a deliberate, logged act — that
role can move money.
