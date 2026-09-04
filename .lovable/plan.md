# Fix: Comprehensive Agent Ops report email must attach a real PDF

## What is actually happening

Traced end to end:

1. **Cron** — pg_cron job `agent-ops-comprehensive-daily-report-midnight-eat` (jobid 18342), schedule `0 21 * * *` (00:00 EAT), `net.http_post` to the edge function `agent-ops-comprehensive-daily-report`. No change needed here.
2. **Data** — `get_agent_products_services_report` (current + previous window) and `get_agent_operational_population`. No change needed.
3. **HTML** — `supabase/functions/agent-ops-comprehensive-daily-report/_lib/report.ts` builds the report HTML (with `_lib/agentOpsReportStyles.ts`).
4. **The bug** — `index.ts` line 121 attaches the HTML string as the "PDF":
   `form.append('attachment', new Blob([html], { type: 'text/html; charset=utf-8' }), filename)`
   and the filename itself ends in `.html`. There is no PDF step at all: the email body is the report and the attachment is the same HTML again.
5. **Already present but never called** — `_lib/pdf.ts` exports `buildComprehensiveReportPdf(...) : Uint8Array`, a complete jsPDF + jspdf-autotable renderer built from the *same* RPC payload as the HTML builder (header band, KPI sections, rent/advance/service-centre/product tables, page footers, `doc.output('arraybuffer')`). It is imported by nothing. This is the renderer to reuse.

## One constraint worth stating plainly

Supabase Edge (Deno) cannot run Chromium, so a literal "render this HTML string to PDF" step is not available in-stack. The two honest options are:

- **A (recommended, no new dependency or secret):** attach the PDF produced by the existing `_lib/pdf.ts` renderer, and keep the HTML report as the email body — so the HTML stays the source of truth for content/figures and the attachment reconciles to it, section for section. This is exactly the pattern already used by `tenant-products-services-report` (pdf-lib) and `agent-growth-daily-report` / `agent-daily-performance-report` (jsPDF).
- **B (only if pixel-identical HTML layout in the PDF is required):** call an external HTML-to-PDF API (e.g. a hosted Chromium service). That needs a new secret (`HTML_TO_PDF_API_KEY` + endpoint) and adds an outbound dependency to the nightly job. No such service exists in the project today.

The plan below implements **A**. Say the word and I will switch to B.

## Changes

**Single file: `supabase/functions/agent-ops-comprehensive-daily-report/index.ts`**

- Import `buildComprehensiveReportPdf` from `./_lib/pdf.ts`.
- After the HTML is built, render the PDF from the same `report` / `population` / dates / `periodLabel` inputs.
- Validate the bytes before use: length > 1000 and the first five bytes are `%PDF-`. Log `pdf_bytes` and the signature check result.
- Attachment: `new Blob([pdfBytes], { type: 'application/pdf' })` with filename
  `Welile_Agent_Ops_Comprehensive_<date|from_to_to>.pdf`.
- `text` body copy updated to say the report is attached as a PDF.
- **Hard failure behaviour:** wrap rendering in try/catch. On any render error or failed signature/size validation, never fall back to HTML-as-PDF. Instead `console.error` the reason and send the email with **no attachment** plus a clear in-body note ("Automated PDF generation failed — the full report is in this email body."), and return `{ ok: true, pdf_attached: false, pdf_error: <message> }` so the failure is visible in function logs. The report itself still reaches recipients — consistent with the other daily reports, which prefer degraded delivery over silence.
- Keep `dry_run` (add `pdf_bytes` / `pdf_ok` / `attachment` to its JSON) and keep the `pdf: true` inline-HTML preview branch, renaming its response field/behaviour so it no longer implies PDF: it will return the PDF binary with `Content-Type: application/pdf` for manual verification, and a new `preview_html: true` keeps the inline HTML preview.

No other file changes. Cron, schedule, recipients, RPCs, report definitions and the HTML builder all stay exactly as they are.

## Secrets / env vars involved

Existing only, no new ones: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_API_BASE`.

## Verification

- `deno check` on the function.
- Deploy, then invoke with `{ "date": "<yesterday>", "dry_run": true }` and confirm `pdf_ok: true` with a sensible byte size.
- Invoke with `{ "date": "<yesterday>", "pdf": true }` and confirm the response body starts with `%PDF-`.
- Invoke with `{ "date": "<yesterday>", "recipients": ["<test address>"] }` and confirm the delivered attachment opens as a PDF and reconciles with the HTML body figures.
