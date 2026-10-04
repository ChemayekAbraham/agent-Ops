---
name: Email transport — Mailgun (US region)
description: All queued email (auth + transactional) is delivered via Mailgun US API through the notify.welile.com sending domain
type: infrastructure
---
All outbound email flows through the existing queue (`enqueue_email` → `process-email-queue`) but the transport is **Mailgun (US region)**, not Lovable email-js.

- `process-email-queue` sends via `POST {MAILGUN_API_BASE}/v3/{MAILGUN_DOMAIN}/messages` with HTTP Basic auth (`api:$MAILGUN_API_KEY`), form-encoded (`from`, `to`, `subject`, `html`, `text`, `h:Reply-To`).
- Secrets: `MAILGUN_API_KEY`, `MAILGUN_DOMAIN=notify.welile.com`, `MAILGUN_API_BASE=https://api.mailgun.net` (US). EU would be `https://api.eu.mailgun.net`.
- Verified sending domain: `notify.welile.com` (active in the US Mailgun account).
- FROM addresses use `@welile.com` (e.g. partnership@ / noreply@); DMARC relaxed alignment holds because notify.welile.com shares org domain welile.com. `payload.sender_domain` is now unused (kept in payloads harmlessly).
- Retry/backoff unchanged: `sendViaMailgun` throws `MailgunError` with `.status` (+`.retryAfterSeconds`), so the existing 429 (rate-limit cooldown) / 403 (DLQ) handling still applies.
- `sendLovableEmail` / `LOVABLE_API_KEY` are no longer used for email delivery.
