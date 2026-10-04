---
name: SMS sender ID — WELILE on all providers
description: WELILE is the registered sender ID forced on Yoola, Africa's Talking, and LANA
type: constraint
---
# SMS sender ID: WELILE (all providers)

**Current rule (2026-07-10):** `WELILE` is a registered/approved sender ID on
Yoola, Africa's Talking, and LANA, and MUST be sent explicitly on every SMS
call site:

- **Yoola** — JSON body field `sender: "WELILE"`.
- **Africa's Talking** — URLSearchParams field `from: "WELILE"`.
- **LANA** — JSON body field `sender_id: "WELILE"`.

Do NOT rely on account defaults; set the sender field explicitly.

Verified live 2026-07-10 against Yoola with the WELILE-enabled account key:
`{"status":"success","sender_used":"WELILE","message_id":185729}` (UGX 30).

## History (superseded)
The 2026-07-09 note that WELILE returned `403 sender_not_allowed` on Yoola and
that the sender should be omitted (defaulting to `ATInfo`) is **obsolete** —
WELILE has since been registered. Never omit the sender to fall back to
`ATInfo`; always force `WELILE`. A matching `YOOLA_SMS_API_KEY` for the
WELILE-enabled account was set on 2026-07-10.
