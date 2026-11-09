# 259 — Partner digital receipts replace the paper receipt books

**Date:** 2026-11-05 · **Status:** BUILT AND TESTED AGAINST A LOCAL POSTGRES, **NOT APPLIED TO PRODUCTION, NOT DEPLOYED.** Migration `20261105180000_partner_receipts.sql` has not been run. Generated types are not regenerated, so the hook calls the RPCs through an untyped `rpc()` wrapper until they are.

## Why
The CTO's manager asked to stop the paper receipt books (Welile Technologies receipt book, series 4101, 4102 ... issued at the Entebbe branch on 3 Nov 2026). The books do five jobs: proof of payment, dispute resolution, Partner Ops records, audit evidence, history. All five must survive. Decision (CTO, 11-05): **no scanning and no historical import**. Digital receipts start from go-live and continue the paper numbering. All receipt-book money already goes through the system (`deposit_requests`), so each receipt links to a real deposit.

## What it is, and is not
A receipt is **evidence, not a money movement.** Nothing here writes `wallets` or `general_ledger`, and the frontend never writes the receipt tables either (read-only RLS; every write is a SECURITY DEFINER RPC). `guard:all` passes.

## Who
| Action | Who |
|---|---|
| Issue, confirm cash, mark delivered, request void/correction | `financial_ops`, `cfo`, `super_admin`, or dashboard grant `financial-ops` / `cfo` |
| View the archive and the daily closing | the issuers plus Partner Ops (`is_partner_ops`) |
| Approve or reject a correction | `cfo`, `super_admin`. **Never the person who asked** |

Where it shows: FinOps Command Center tool `partner_receipts` and the FinOps menu ("Records & audit"), CFO dashboard sidebar "Partner Receipts" (`partner-receipts`), Partner Ops "Financial > Receipts" (`financial.receipts`). One shared component: `src/components/shared/PartnerReceiptsPanel.tsx`.

## Controls (each one tested)
- **Numbering continues the paper series.** Counter row starts at 4102, so the first digital receipt is **4103**, code `WEL-RCP-<year>-<6 digits>`. It is a one-row counter updated inside the issuing transaction, not a sequence, so rejected attempts never burn a number. Test: 8 rejected attempts between issues, numbers stayed 4103-4106.
- **Immutable.** Trigger blocks DELETE and any edit of amount, payer, method, purpose, date, deposit link, issuer. Only status (issued to voided), cash confirmation, delivery and the supersede link change. The event history is append-only.
- **Corrections, not edits.** Void or correct request with a reason, then the CFO decides. Approval voids the original (kept, shown struck through and stamped VOIDED on its PDF) and, for a correction, issues a new receipt pointing back. The replacement keeps the original issuer; the approver is on the original's `voided` event. One pending request per receipt.
- **Deposit link.** Receipt amount must equal the deposit; a rejected deposit cannot be receipted; one live receipt per deposit (partial unique index). A corrected receipt whose amount changed is created **unlinked** (the deposit no longer matches) and shows in the closing report until Financial Ops sorts out the deposit.
- **Cash needs a second person.** A cash receipt is flagged until a different staff member counts and confirms it. A corrected cash receipt needs confirming again.
- **7-day back-dating limit** on fresh receipts; no future dates; cheque/draft needs its number.
- **Daily closing report** (`partner_receipts_daily_closing`): totals by method, voided, corrections waiting, receipts with no system deposit, unconfirmed cash, undelivered receipts. "Counted cash vs recorded cash" is NOT built; it needs a physical count entry (see below).

## Verified locally (Postgres 17, stub tables)
Migration applies; 30+ behaviour checks pass: nobody and anon denied; Partner Ops can search but not issue; Financial Ops cannot approve; CFO cannot approve their own request; browser role cannot insert/update/delete or read the counter or call the internal insert; amount mismatch, rejected deposit and double receipt all refused. Not tested against the real `deposit_requests`/`profiles`/`user_roles` (production schema drifts from the migrations, so confirm `deposit_requests.status` values and `profiles.full_name` after applying).

## Not built yet
- **Sending the receipt** by email/SMS/WhatsApp and a delivery confirmation. Today: download the PDF (marks "delivered via download"). Needs an email template through the transactional-email registry and an SMS path.
- **Public verification page** for `verify_token` (printed on the PDF as a verification code). Column exists; no anon endpoint yet.
- **Counted-cash entry** for the closing report.
- **Link picker**: the issue dialog takes a pasted deposit ID. A search over pending/approved deposits should replace it.
- **Correction of an old receipt's deposit link** when the amount changes.
- Supplier-receipt attachment for audits (separate workflow, not part of this).
- Accountant to confirm whether EFRIS applies; the PDF states it is an internal acknowledgement, not a URA fiscal receipt.

## To go live
1. Review and apply `20261105180000_partner_receipts.sql` (roll back: `...rollback.sql`, destructive). Add grants check: `has_table_privilege('authenticated','public.partner_receipts','SELECT')`.
2. Regenerate types, then `npm run schema:accept-types`; drop the `(supabase as any)` wrapper in `usePartnerReceipts.ts`.
3. Paper cut-over: last paper receipt 4102 (confirm no later paper book entries exist), first digital 4103. If paper continues anywhere, set `partner_receipt_counter.last_no` above it before go-live.
4. Message Lovable after any push.

## Files
`supabase/migrations/20261105180000_partner_receipts.sql` (+ rollback) · `src/hooks/usePartnerReceipts.ts` · `src/lib/partnerReceiptPdf.ts` · `src/components/shared/PartnerReceiptsPanel.tsx` · mounts in `FinancialOpsCommandCenter.tsx`, `new-ui/finopsMenu.ts`, `pages/cfo/Dashboard.tsx`, `executiveSidebarConfig.ts`, `PartnersOpsDashboard.tsx`, `partner-ops/partnerOpsNav.ts`.
