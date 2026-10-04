---
name: Payout proof-of-payment receipt
description: Public tokenized receipt page (/r/:token) + QR + PDF download; SMS/push links generated when a merchant agent confirms a withdrawal payout
type: feature
---
When a merchant agent confirms a payout (`approve-withdrawal` edge fn, any settle path), the customer, merchant, in-app notification, and push all link to a verifiable proof-of-payment receipt.

**Secure token URL (primary):** `https://welilereceipts.com/r/<receipt_token>`. `withdrawal_requests.receipt_token` = unguessable 32-char hex (128-bit), column DEFAULT `substr(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),1,32)`, unique index, backfilled for existing rows. Prevents receipt enumeration. Legacy id URL `/receipt/:id` still works (in-app/authenticated).

**Public page:** `src/pages/PayoutReceipt.tsx`, routes `/r/:token` and `/receipt/:id` (App.tsx, public/no-auth). Loads via SECURITY DEFINER RPCs `get_payout_receipt_by_token(p_token text)` (resolves token→id then calls the by-id builder) and `get_payout_receipt(p_withdrawal_id uuid)`; both granted anon/authenticated/service_role. Returns NULL if not found, `{paid:false,status}` if unsettled, else full jsonb. Only for `status in ('completed','fin_ops_approved')` with non-null `processed_at`.

**Receipt fields:** receipt_number (`WD`+YYMMDD+`-`+6 hex of id), transaction_type ('Cash Withdrawal'), amount, commission (0.5% ledger leg `<id>-cashout-commission`), recipient_name (customer), processor_name/phone (merchant agent), merchant_branch (`cashout_agents.label` of processed_by), reference (=`fin_ops_reference` TID), processed_at, receipt_token. Method-gated destination: bank → bank_name/account_number/account_name; MoMo/cash → mobile_money_number/name/provider.

**Page features:** COMPLETED status badge, on-screen QR (`qrcode.react` QRCodeCanvas) resolving to the public token URL, and a **Download PDF** button that builds the receipt with `jspdf` + `qrcode` toDataURL (programmatic layout — avoids html2canvas oklch issues). PDF filename `welile-receipt-<receipt_number>.pdf`.

**Messaging (approve-withdrawal):** customer SMS = "Withdrawal Successful … Transaction ID … digital receipt <url>"; merchant SMS = "Payout Completed … paid UGX X to {customer} … Commission Earned … TID … Receipt <url>"; customer push = "Withdrawal Completed / tap to view receipt" (url `/r/{token}`); notification metadata carries `receipt_url` + `receipt_token`. `receiptToken` fetched once and shared across all channels.

The TID the agent enters at confirm time IS the proof; the receipt is auto-generated from it — no separate image upload.

## Multi-channel delivery (2026-07-07)
The receipt link is now delivered to the customer on THREE channels (all idempotent per withdrawal), not just SMS:
- **SMS** — via `sendSMS` (Yoola/Africa's Talking/Lana).
- **Email** — ALWAYS sent now (no longer only an SMS-failure fallback) whenever an email is on file. `buildWithdrawalPaidReceiptRequest` takes `receiptUrl`; template `withdrawal-paid-receipt.tsx` shows a primary "View & download your receipt" button + plain link. In `approve-withdrawal`, `sendReceiptEmail("primary channel")` fires unconditionally (old `sendFallbackReceiptEmail` is now an alias, so SMS-failure call sites still work as no-ops after the first send).
- **WhatsApp** — best-effort via `_shared/whatsapp.ts` `sendWhatsApp()` using the Twilio Messages API. Reads `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (+ optional `TWILIO_WHATSAPP_CONTENT_SID` for approved out-of-window template). Safe no-op (logs, never throws) when the WhatsApp sender is not configured. `toE164()` normalises Ugandan numbers. Same receipt URL in every channel.

NOTE: WhatsApp only activates once the Twilio WhatsApp sender secrets are added; outbound/unsolicited WhatsApp requires a pre-approved Content template (set `TWILIO_WHATSAPP_CONTENT_SID`) to deliver outside the 24h customer-service window.

## Receipt distribution (2026-07-07)
On every completed payout, `approve-withdrawal` now emails the SAME secure receipt link to FOUR internal/archive parties in addition to the customer (who gets SMS + email + WhatsApp):
- **Merchant agent / processor** (`processed_by` = caller `user.id`) — also still gets the commission SMS with the link.
- **Financial Ops** — all users with the `operations` role.
- **CFO** — all users with the `cfo` role.
- **Records archive** — fixed address `weliletenants@gmail.com`.

Implemented via a "receipt copy" variant: `buildWithdrawalPaidReceiptRequest` accepts `copyFor` (recipient label) + `idempotencySuffix` (normalised email → one idempotent email per recipient); `withdrawal-paid-receipt.tsx` renders an internal "Payout receipt (copy)" layout (no wallet balance, neutral footer) when `copy_for` is set. Fan-out dedupes by lowercased email and skips the customer's own address (they already got the primary). All best-effort, never blocks the approval response.

## Commission content validation rule (2026-07-07)
The commission-disclosure invariant is now centrally enforced, not just conditionally rendered:
- **`src/lib/receiptContentPolicy.ts`** (frontend) + mirror **`supabase/functions/_shared/receipt-content-policy.ts`** (Deno) — single source of truth. `ReceiptAudience = 'customer' | 'merchant' | 'internal'`. Rule: commission is included **iff** audience === `'merchant'`. Helpers: `audienceIncludesCommission`, `commissionForAudience(audience, raw)` (strips → null unless merchant), `validateReceiptContent(audience, commissionIncluded)`, and throwing `assertReceiptContent(...)`.
- **Customer PDF** (`payoutReceiptPdf.ts` `downloadPayoutReceiptPdf`) calls `assertReceiptContent('customer', false)` — never draws a commission line.
- **Email builder** (`buildWithdrawalPaidReceiptRequest`) derives audience from `copyFor` (null→customer, `'Merchant Agent'`→merchant, else→internal), normalises `commission_earned` via `commissionForAudience`, and asserts before building. So customer + FinOps/CFO/archive copies can never carry commission and the merchant copy always does. Keep the two policy modules in sync.

## Authenticity e-stamp watermark (2026-07-07)
Every payout receipt now carries the Welile Technologies official e-stamp as a faint authenticity watermark (blue border, serif "WELILE TECHNOLOGIES LIMITED", red current date flanked by ★ stars, "PO Box 167564 Kampala Uganda").
- **`src/components/receipts/WelileStamp.tsx`** — reusable component. `stampDate(date?)` formats a date in the physical-stamp format (`en-GB`, `DD MON YYYY`, uppercased, e.g. `07 JUL 2026`). **(2026-09-22, reversed prior decision)** the date is the receipt's own `processed_at`, not the viewing date — a past receipt showing today's date every time it's reopened undermines the "authenticity" the stamp exists to convey (see HANDOVER 103). `stampDate()`/`WelileStamp`'s `date` prop only fall back to `new Date()` when no date is passed. Fonts (Crimson Text / Oswald / Nunito) are lazy-loaded once via an injected `<link>`. `watermark` prop drops opacity to 0.16.
- **Web receipt** (`PayoutReceipt.tsx`) — stamp overlaid `absolute inset-0 z-20 pointer-events-none` at `scale={0.62}`, centered, readable under the text; passes `date={data.processed_at}`.
- **PDF** (`payoutReceiptPdf.ts` `drawStampWatermark`) — vector reproduction at opacity 0.14 via jsPDF `GState`, centered at y≈430; uses `*` for stars (core fonts lack ★) and `times` bold for the serif company line. Passes `data.processed_at` through to `stampDate()` so the PDF stamp matches the web and stays fixed to the transaction date.
