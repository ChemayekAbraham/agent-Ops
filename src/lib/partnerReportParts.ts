import welileLogoUrl from '@/assets/welile-logo.png';
import { DASH, esc } from './welileReportDocument';
import { PARTNER_STATEMENT_CSS } from './partnerStatementStyles';

/**
 * Pieces shared by the partner Statement and the Projection report so both
 * carry the exact same page-1 header, running header, footer and look. The
 * stylesheet is the approved statement template's (partnerStatementStyles.ts).
 */

export const WELILE_OFFICE = 'Palm Lane Kabaale, Entebbe Uganda';
export const WELILE_PARTNER_EMAIL = 'partnership@welile.com';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "05 Mar 2026" from an ISO date or timestamp; a dash when unusable. */
export const day = (v: string | null | undefined): string => {
  const s = String(v ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return DASH;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
};

export interface HeaderMetaRow { label: string; value: string; mono?: boolean; date?: boolean }
export interface HeaderSummaryRow {
  label: string;
  /** Already-escaped HTML. */
  valueHtml: string;
  closing?: boolean;
}

/** Page-1 header: company + account details on the right, customer + summary below. */
export function reportHeaderHtml(opts: {
  meta: HeaderMetaRow[];
  customerName: string;
  /** Already-escaped HTML, one per line under the name. */
  customerLines: string[];
  branch?: string;
  summary: HeaderSummaryRow[];
}): string {
  const meta = opts.meta.map((r) =>
    `<div class="meta-line"><span class="meta-lbl">${esc(r.label)}:</span> <span class="meta-val${r.mono ? ' font-mono' : ''}${r.date ? ' date' : ''}">${esc(r.value)}</span></div>`,
  ).join('\n        ');
  const summary = opts.summary.map((r) => r.closing
    ? `<tr class="closing-balance-row">
          <td class="bal-lbl font-bold" style="color:var(--text-main);">${esc(r.label)}</td>
          <td class="bal-val num font-bold" style="font-size:9.5px; color:var(--text-main);">${r.valueHtml}</td>
        </tr>`
    : `<tr><td class="bal-lbl">${esc(r.label)}</td><td class="bal-val num">${r.valueHtml}</td></tr>`,
  ).join('\n        ');

  return `<header class="bank-statement-header">
  <div class="header-top-container">
    <div class="header-right-block">
      <div class="header-bank-identity">
        <img src="${welileLogoUrl}" alt="Welile" class="bank-logo" />
        <div class="bank-address-block">
          <div class="bank-company-name">Welile Technologies Limited</div>
          <div>${WELILE_OFFICE}</div>
          <div>${WELILE_PARTNER_EMAIL} &bull; welileapp.com</div>
        </div>
      </div>
      <div class="account-meta-block">
        ${meta}
      </div>
    </div>
  </div>
  <div class="header-summary-row">
    <div class="customer-info-col">
      <div class="customer-name">${esc(opts.customerName)}</div>
      ${opts.customerLines.map((l) => `<div class="customer-detail">${l}</div>`).join('\n      ')}
      ${opts.branch ? `<div class="customer-branch">${esc(opts.branch)}</div>` : ''}
    </div>
    <div class="balance-summary-col">
      <table class="balance-summary-table">
        ${summary}
      </table>
    </div>
  </div>
</header>`;
}

/** Header for pages 2+. `title` is already-escaped HTML. */
export function runningHeaderHtml(opts: {
  title: string;
  accountLabel: string;
  accountValue: string;
  holderLabel: string;
  holder: string;
  date: string;
  page: number;
  total: number;
}): string {
  return `<header class="detail-running-header">
  <div class="running-header-left">
    <img src="${welileLogoUrl}" alt="Welile" class="running-logo" />
    <div class="running-company-info">
      <span class="running-company-name">Welile Technologies Limited</span>
      <span class="running-contact">${WELILE_OFFICE} &bull; ${WELILE_PARTNER_EMAIL}</span>
    </div>
  </div>
  <div class="running-header-right">
    <div class="running-doc-title">${opts.title}</div>
    <div class="running-meta-line">
      <span><strong>${esc(opts.accountLabel)}:</strong> ${esc(opts.accountValue)}</span><span>&bull;</span>
      <span><strong>${esc(opts.holderLabel)}:</strong> ${esc(opts.holder)}</span><span>&bull;</span>
      <span><strong>Date:</strong> ${esc(opts.date)}</span><span>&bull;</span>
      <span><strong>Page ${opts.page} of ${opts.total}</strong></span>
    </div>
  </div>
</header>`;
}

export function reportFooterHtml(opts: {
  docName: string;
  ref: string;
  page: number;
  total: number;
  /** Left-hand label, e.g. CONFIDENTIAL FINANCIAL STATEMENT. */
  confidential?: string;
}): string {
  return `<footer class="report-footer">
    <span class="footer-left">WELILE TECHNOLOGIES LIMITED &bull; ${esc(opts.confidential ?? 'CONFIDENTIAL FINANCIAL STATEMENT')}</span>
    <span class="footer-center">${esc(opts.docName)} &bull; REF: ${esc(opts.ref)}</span>
    <span class="footer-right">PAGE ${opts.page} OF ${opts.total} &bull; welileapp.com</span>
  </footer>`;
}

/** A complete standalone document around already-built `<article class="report-page">` pages. */
export function reportDocumentHtml(title: string, pages: string[]): string {
  const baseTag = typeof window !== 'undefined' && window.location?.origin
    ? `<base href="${window.location.origin}/">`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
${baseTag}
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${PARTNER_STATEMENT_CSS}</style>
</head><body>
<main class="document-wrapper">${pages.join('\n')}</main>
<script>window.__WELILE_READY__ = true;</script>
</body></html>`;
}
