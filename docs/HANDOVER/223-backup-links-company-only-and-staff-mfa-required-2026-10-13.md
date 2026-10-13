# 223 — Backup links to company mailboxes only, 24h expiry; staff 2-step verification required (2026-10-13)

**Status: section 1 (backups) is committed on a dev branch, NOT DEPLOYED. Section 2 (staff MFA) is written in the working tree but deliberately NOT committed or deployed — held by Josh 2026-10-13 pending real emails for 14 exempt staff.** Edge functions need deploying (via Lovable) — see "Deploy order".
Driver: DPO request for the PDPO registration (draft: `docs/PDPO_DATA_INVENTORY_DRAFT_2026-10-13.md`).
Both items were declared gaps: backup links went to a personal Gmail, and MFA was not enforced.

## 1. Backups

| Before | After |
|---|---|
| Weekly dump link emailed to `joshwanda17@gmail.com` + `ssenkaali.pius@welile.com` | `joshua.wanda@welile.com` + `ssenkaali.pius@welile.com` (`DEFAULT_BACKUP_RECIPIENTS`) |
| Ledger backup template hard-wired to `joshwanda17@gmail.com` | `joshua.wanda@welile.com` (template `to` + `LEDGER_BACKUP_RECIPIENT`) |
| `resend-database-backup-link` accepted ANY address from the request body, defaulting to two Gmails | only `@welile.com` addresses; others are dropped and returned in `rejected`; none left = HTTP 400 |
| Signed URL valid 7 days (168 h) | 24 h (`BACKUP_LINK_TTL_SECONDS`); templates and `expiresInHours` follow it |

Shared rules live in `supabase/functions/_shared/backupDelivery.ts`; change recipients there, never at call sites.

**Not fixed (be honest on the PDPO form):** the dump is still stored in the same Supabase project as production,
is not encrypted beyond platform at-rest, has no retention rule, and the weekly one is still capped at 1,000 rows/table.
The link is still a bearer URL sent over email (Mailgun, US).

**UI follow-up for Gemini:** `RunBackupNowButton.tsx` pre-fills personal Gmail recipients and says "valid 7 days".
The server now rejects the Gmails, so the default text and label need updating.

## 2. Staff 2-step verification

Before: email-code device check existed but only for users who switched it on. Live measurement 2026-10-13:
70 staff accounts (any role other than agent/tenant/landlord/supporter), **1** with 2MFA on, 52 active in the
last 30 days, 51 of those without it, **13** with an unusable (placeholder/missing) email.

After: `two-factor-challenge` treats any staff account as enabled (`_shared/staffMfa.ts`). Every staff device must
verify an emailed code once, then is trusted. `two-factor-manage` refuses `disable` for staff. `status` now also
returns `required` and `required_unreachable`.

- **Unreachable staff (placeholder email) are NOT blocked** — a code could never arrive and they would be locked out.
  They stay unprotected until given a real email; list them with the query below. This is still a gap on the form.
- **Kill switch:** edge secret `STAFF_MFA_ENFORCE=false` turns enforcement off without a redeploy.
- **Limit:** enforcement is the existing full-screen `TwoFactorGate` in the browser plus the server-side status
  check. API/RPC calls made with a valid JWT from an unverified device are not blocked. State this as "enforced at
  the application gate", not "enforced on every endpoint".
- Does not cover Supabase / Lovable / GitHub / Google / Mailgun admin logins — those need their own 2-step setting
  turned on in each vendor's console (Josh/Pius to do and confirm).

Rollout risk: ~52 active staff are prompted for a code on their next load; if Mailgun is down they cannot reach
dashboards. Deploy outside payout hours and keep the kill switch ready.

```sql
-- Staff who cannot receive a code
select u.id, u.email, p.full_name
from auth.users u join profiles p on p.id = u.id
where exists (select 1 from user_roles r where r.user_id = u.id and r.role::text not in ('agent','tenant','landlord','supporter'))
  and (u.email ~* '(welile\.(user|agent|app|local|test)|app\.local|no-email\.local|deleted\.invalid)$');
```

## Deploy order
1. Deploy `two-factor-challenge`, `two-factor-manage` (staff MFA goes live on deploy).
2. Deploy `weekly-database-backup`, `general-ledger-backup`, `resend-database-backup-link` and the email templates (`send-transactional-email` bundles them).
3. After the next weekly run, confirm the email arrived at the welile.com addresses and `backup_runs.recipients` shows them.

Verified: `npm run guard:all` passes. No Deno available locally, so the edge functions were not type-checked or run.
