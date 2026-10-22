# Register of systems and third-party services (Information and Security Policy §3, §9, §11)

Maintained by Engineering, reviewed by the DPO. Built on 2026-10-22 from the production configuration and a scan of every outside address the code calls (edge functions and browser app).
**Rule for this file:** only facts verified from the system are stated as fact. "TO CONFIRM" means the vendor's hosting country, sub-processors or agreement have not been checked yet and must be confirmed with the vendor before this register is relied on.
Add a row before any new service starts holding personal data (§11). Review at least annually and on any material change.

## A. Systems the company operates

| System | Purpose | Personal data held | Hosting | Notes |
|---|---|---|---|---|
| Supabase project `byrzshwlentqvktcksem` | Production database, sign-in, file storage, edge functions, realtime, scheduled jobs | All personal and financial data: tenants, agents, landlords, supporters, staff, wallets, ledger, identity numbers, locations | **eu-west-1 (Ireland)**, company-owned account (moved from Lovable Cloud on 2026-10-17 for PDPO compliance) | Row-level security on every table; audit trail in `audit_logs` (append-only since 2026-10-22). Supabase's encryption-at-rest statement: confirm in its DPA. |
| Frontend app (welileapp.com) | Web app for tenants, agents, partners, staff | Shown to signed-in users per role | Deployed by Lovable | Source in GitHub; Lovable is deploy-only (see `CLAUDE.md`). |
| GitHub repository `weliletenants-sys/welilereceipts-com-98bba33b` | Source code, migrations, documentation | No production personal data intended; commit history may contain historic test data | GitHub, country TO CONFIRM | Branches: `dev/<name>`, `staging`, `lovable`, `main`. |
| CTO laptop | Development, exports for migration | Encrypted copies of historic database exports (Windows file encryption tied to the Windows login); two older copies in OneDrive not yet encrypted or deleted | Uganda (physical) | Risks R1, R7, R10. |

## B. Third-party services that process personal data

| Vendor | Service | Data sent or held | Where in the system | Hosting country | Sub-processors | Written agreement |
|---|---|---|---|---|---|---|
| Africa's Talking | SMS, USSD, voice calls (browser calling and call events), delivery reports | Phone numbers, message text including one-time codes, call metadata, call recording if enabled (`CRM_CALL_RECORDING`) | Edge functions `sms-*`, `ussd-callback`, `crm-*`; about 59 functions use its key | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| Yoola SMS (yoolasms.com) | SMS gateway (main bulk sender) | Phone numbers, message text | `_shared/sendSmsMultiProvider.ts` | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| Lana SMS (lanasms.com) | SMS gateway (fallback) | Phone numbers, message text | `_shared/sendSmsMultiProvider.ts` | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| "Gate" SMS provider | SMS gateway recorded as `gate` in `sms_delivery_log` (all messages through it fail) | Phone numbers, message text | `_shared/sendSmsMultiProvider.ts` | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| Twilio (through the Lovable connector gateway) | WhatsApp and SMS | Phone numbers, message text | `whatsapp.ts`, `sms-delivery-report` | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| Mailgun | Transactional email sending and inbound mail | Email addresses, message content | `process-email-queue`, `send-transactional-email` | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| Google (Gmail API) | Reads incoming mobile-money deposit emails for reconciliation | Mailbox content: payer names, phone numbers, amounts, transaction IDs | `gmail-poll-transactions` | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| Lovable | Deployment of the frontend; AI gateway; connector gateway | Source code; content sent to the AI assistant and to connectors | `ai.gateway.lovable.dev`, `connector-gateway.lovable.dev` | TO CONFIRM | TO CONFIRM | Written confirmation that data from the old Lovable Cloud database is deleted: TO CONFIRM |
| Slack | Operational alerts | Alert text; check that no personal data is included (`bridge-gap-alert-notify`, `deposit-match-alert-notify`, `gmail-poll-heartbeat`) | Edge functions | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| OpenStreetMap Nominatim | Address search and reverse geocoding | GPS coordinates or typed addresses | Browser app | TO CONFIRM | n/a | None (public service) |
| ipify, ipwho.is (and possibly ipapi.co, ip-api.com) | Visitor IP lookup | The visitor's IP address | Browser hooks and edge function | TO CONFIRM | n/a | None (public service); replace with server-side IP (R4) |
| QuickChart (quickchart.io) | Chart images for reports | Chart data in the request URL: TO REVIEW whether it includes personal or financial data | Edge functions | TO CONFIRM | n/a | None (public service) |
| Google Analytics / Tag Manager | Site analytics | Visitor identifiers, pages viewed | `index.html` | TO CONFIRM | TO CONFIRM | TO CONFIRM |
| Microsoft OneDrive | File sync of Desktop, Pictures and Documents on the CTO laptop | Two older database export copies and a browser-logins backup (unencrypted) | CTO laptop sync | TO CONFIRM | TO CONFIRM | None; stop syncing (R1) |
| Google Drive | Archive of tenant documents (downloaded zips on the laptop came from here) | Tenant identity and tenancy documents | Staff use | TO CONFIRM | TO CONFIRM | TO CONFIRM |

## C. Backup locations (§9)

| Copy | Where | Encrypted | Access |
|---|---|---|---|
| Live database | Supabase eu-west-1 (Ireland) | Managed by Supabase (confirm) | Named staff via roles and the Supabase dashboard |
| Platform backups | Supabase (plan and retention to confirm) | Managed by Supabase (confirm) | Supabase dashboard |
| Weekly database backup email, nightly ledger backup email | Email provider (country TO CONFIRM); download link valid 24 hours; recipients `@welile.com` only | Link-based; not encrypted storage | Anyone with the link inside the window (R2) |
| Cutover dumps on the CTO laptop | `pdpo-rehearsal` and Downloads | Windows file encryption tied to the Windows login (since 2026-10-20) | CTO only |
