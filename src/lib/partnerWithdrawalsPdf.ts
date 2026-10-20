import { DASH, esc, num, ugx } from './welileReportDocument';
import {
  WELILE_OFFICE,
  WELILE_PARTNER_EMAIL,
  day,
  reportDocumentHtml,
  reportFooterHtml,
  reportHeaderHtml,
  runningHeaderHtml,
} from './partnerReportParts';

export interface PartnerWithdrawalPdfRow {
  partner: string;
  /** Portfolio the money was withdrawn for — partners withdraw per portfolio. */
  portfolio?: string;
  agent: string;
  payee: string;
  method: string;
  reference: string;
  amount: number;
  status: string;
  date: string; // ISO
  note?: string;
}

export interface PartnerWithdrawalsPdfInput {
  rows: PartnerWithdrawalPdfRow[];
  searchTerm?: string;
  generatedAt?: Date;
}

const statusLabel = (s: string) =>
  (s || DASH).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const statusTag = (s: string) =>
  s === 'completed'
    ? '<span class="status-tag tag-active">Completed</span>'
    : `<span class="status-tag tag-closed">${esc(statusLabel(s))}</span>`;

/* Pagination estimates in CSS px, same model as the partner statement. */
const SHEET_PX = 1000;
const PAGE1_CHROME_PX = 330;
const CONT_CHROME_PX = 60;
const ROW_PX = 17;
const COMPLETION_PX = 95;

/**
 * Partner & proxy-partner withdrawals export, rendered with the exact same
 * HTML template and rasteriser as the partner portfolio statement, so both
 * documents carry the same header, tables, footer and look.
 */
export async function generatePartnerWithdrawalsPdf(input: PartnerWithdrawalsPdfInput): Promise<Blob> {
  const rows = input.rows;
  const generatedAt = input.generatedAt || new Date();
  const stamp = generatedAt.toISOString().slice(0, 10);
  const ref = `W-PPW-${stamp.slice(0, 4)}-${stamp.slice(5, 7)}${stamp.slice(8, 10)}`;

  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const completed = rows.filter((r) => r.status === 'completed');
  const completedTotal = completed.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const pendingCount = rows.length - completed.length;

  const dates = rows.map((r) => String(r.date ?? '').slice(0, 10)).filter(Boolean).sort();
  const period = dates.length ? `${day(dates[0])} to ${day(stamp)}` : day(stamp);

  const header = reportHeaderHtml({
    meta: [
      { label: 'Report', value: 'Partner Ops — Executive Hub' },
      { label: 'Statement Date', value: day(stamp), date: true },
      { label: 'Period Covered', value: period },
      { label: 'Statement Ref', value: ref, mono: true },
    ],
    customerName: 'PARTNER & PROXY PARTNER WITHDRAWALS',
    customerLines: [
      input.searchTerm
        ? `Filter: search &ldquo;${esc(input.searchTerm)}&rdquo;`
        : 'Filter: All approved records',
      `Records: <strong>${num(rows.length)}</strong>`,
      'Reporting Currency: UGX (Uganda Shilling)',
    ],
    branch: '<Welile Partner Portfolio Division>',
    summary: [
      { label: 'Total Listed:', valueHtml: esc(ugx(total)) },
      {
        label: 'Completed:',
        valueHtml: `<strong>${num(completed.length)}</strong> <span class="text-muted" style="font-size:6.8px; font-weight:normal;">(${esc(ugx(completedTotal))})</span>`,
      },
      { label: 'Pending / In Progress:', valueHtml: `<strong>${num(pendingCount)}</strong>` },
      { label: 'Total Paid Out to Date:', valueHtml: esc(ugx(completedTotal)), closing: true },
    ],
  });

  const note = `<div class="statement-disclosure-block">
  <div class="disclosure-title">Report Note &amp; Reconciliation Disclosure</div>
  <div class="disclosure-body">
    This register lists every approved partner and proxy-partner withdrawal${input.searchTerm ? ` matching the search &ldquo;${esc(input.searchTerm)}&rdquo;` : ''}. Amounts are the recorded payout figures per withdrawal; a row marked <strong>Completed</strong> has been verified and paid out by Financial Ops, while any other status is still moving through the payout pipeline.
  </div>
</div>`;

  const tableRows = rows.map((r, i) => `<tr>
    <td class="text-center text-muted font-mono">${i + 1}</td>
    <td class="font-bold">${esc(r.partner || DASH)}</td>
    <td>${esc(r.portfolio || DASH)}</td>
    <td>${esc(r.agent || DASH)}</td>
    <td>${esc(r.payee || DASH)}</td>
    <td>${esc(r.method || DASH)}</td>
    <td class="font-mono text-muted">${esc(r.reference || DASH)}</td>
    <td class="text-right num font-semibold">${esc(ugx(Number(r.amount) || 0))}</td>
    <td class="text-center">${statusTag(r.status)}</td>
    <td class="text-center date">${day(r.date)}</td>
  </tr>`);

  const TABLE_HEAD = `<tr>
    <th style="width:20px;" class="text-center">#</th>
    <th>Partner</th>
    <th>Portfolio</th>
    <th>Agent</th>
    <th>Payee</th>
    <th style="width:70px;">Method</th>
    <th style="width:90px;">Reference</th>
    <th class="text-right" style="width:80px;">Amount</th>
    <th class="text-center" style="width:70px;">Status</th>
    <th class="text-center" style="width:70px;">Date</th>
  </tr>`;

  const tableFoot = `<tr>
    <td colspan="7" class="text-right font-bold" style="text-transform:uppercase;">Totals (${num(rows.length)} record${rows.length === 1 ? '' : 's'}):</td>
    <td class="text-right num font-bold text-primary">${esc(ugx(total))}</td>
    <td colspan="2" class="text-center text-muted" style="font-size:7px;">${num(completed.length)} completed &bull; ${num(pendingCount)} pending</td>
  </tr>`;

  const firstCap = Math.max(8, Math.floor((SHEET_PX - PAGE1_CHROME_PX) / ROW_PX));
  const contCap = Math.floor((SHEET_PX - CONT_CHROME_PX - 60) / ROW_PX);
  const chunks: string[][] = [tableRows.slice(0, firstCap)];
  for (let i = firstCap; i < tableRows.length; i += contCap) {
    chunks.push(tableRows.slice(i, i + contCap));
  }

  // The completion panel closes the last page; if it will not fit there, it gets one.
  const lastUsed = (chunks[chunks.length - 1]?.length ?? 0) * ROW_PX;
  const panelOnOwnPage = lastUsed + COMPLETION_PX > SHEET_PX - CONT_CHROME_PX - 60;
  const totalPages = chunks.length + (panelOnOwnPage ? 1 : 0);

  const footer = (i: number) =>
    reportFooterHtml({ docName: 'PARTNER WITHDRAWALS REGISTER', ref, page: i, total: totalPages, confidential: 'CONFIDENTIAL PAYOUT RECONCILIATION RECORD' });

  const completion = `<div class="statement-completion-panel">
  <div class="completion-panel-header">
    <span class="completion-title">Official Report Completion Verification</span>
    <span class="font-mono text-muted" style="font-size:7px;">REF: ${esc(ref)}</span>
  </div>
  <div class="completion-body">
    <p>This document constitutes the complete Partner &amp; Proxy Partner Withdrawals register covering <strong>${num(rows.length)}</strong> approved record${rows.length === 1 ? '' : 's'} totalling <strong>${esc(ugx(total))}</strong> as of <strong>${day(stamp)}</strong>. All recorded payouts are maintained under the financial administration of Welile Technologies Limited.</p>
    <div class="completion-contact-row">
      <span><strong>Partner Office:</strong> ${WELILE_PARTNER_EMAIL}</span><span>&bull;</span>
      <span><strong>Partner Portal:</strong> welileapp.com</span><span>&bull;</span>
      <span><strong>Head Office:</strong> ${WELILE_OFFICE}</span>
    </div>
  </div>
</div>`;

  const pages = chunks.map((chunk, i) => {
    const pageNo = i + 1;
    const isLast = i === chunks.length - 1;
    const section = `<section>
      <div class="section-header-bar">
        <span class="section-title">${i === 0
          ? `Withdrawals Register (All ${num(rows.length)} Approved Record${rows.length === 1 ? '' : 's'})`
          : 'Withdrawals Register (continued)'}</span>
        <span class="section-subtitle">Partner, portfolio, payee, method, reference, amount and status</span>
      </div>
      <div class="master-table-wrapper">
        <table class="master-schedule-table">
          <thead>${TABLE_HEAD}</thead>
          <tbody>${chunk.join('')}</tbody>
          ${isLast ? `<tfoot>${tableFoot}</tfoot>` : ''}
        </table>
      </div>
      ${isLast && !panelOnOwnPage ? completion : ''}
    </section>`;
    return `<article class="report-page">
  <div class="page-content">
    ${i === 0 ? `${header}${note}` : runningHeaderHtml({
      title: 'PARTNER WITHDRAWALS REGISTER',
      accountLabel: 'Report', accountValue: 'Partner Ops',
      holderLabel: 'Records', holder: num(rows.length),
      date: day(stamp), page: pageNo, total: totalPages,
    })}
    ${section}
  </div>
  ${footer(pageNo)}
</article>`;
  });

  if (panelOnOwnPage) {
    pages.push(`<article class="report-page">
  <div class="page-content">
    ${runningHeaderHtml({
      title: 'PARTNER WITHDRAWALS REGISTER &mdash; COMPLETION',
      accountLabel: 'Report', accountValue: 'Partner Ops',
      holderLabel: 'Records', holder: num(rows.length),
      date: day(stamp), page: totalPages, total: totalPages,
    })}
    <div class="portfolio-schedule-list">${completion}</div>
  </div>
  ${footer(totalPages)}
</article>`);
  }

  const html = reportDocumentHtml('Welile — Partner Withdrawals Register', pages);
  const { renderReportPdfBlob } = await import('@/components/partner/renderAgreementPdf');
  return renderReportPdfBlob(html);
}
