import { esc, n, ugx } from './welileReportDocument';
import {
  WELILE_OFFICE,
  WELILE_PARTNER_EMAIL,
  day,
  reportDocumentHtml,
  reportFooterHtml,
  reportHeaderHtml,
  runningHeaderHtml,
} from './partnerReportParts';

/**
 * Projection report: what an account is expected to earn over its term.
 *
 * Built from the same header, stylesheet and page chrome as the partner
 * Statement (partnerReportParts.ts) so the two read as one set of documents.
 * Wording deliberately avoids investment terms: Contribution, Monthly Return,
 * Projected Returns, Account.
 */

export interface ProjectionInput {
  portfolioCode: string;
  accountName: string | null;
  investmentAmount: number;
  roiPercentage: number;
  roiMode: string;
  totalRoiEarned: number;
  status: string;
  createdAt: string;
  durationMonths: number;
  payoutDay?: number | null;
  nextRoiDate?: string | null;
  maturityDate?: string | null;
  ownerName?: string;
}

const PAGE1_ROWS = 22;   // schedule rows that fit under the page-1 header
const CONT_ROWS = 46;    // rows per continuation page
const MAX_MONTHS = 36;

const isCompoundingMode = (mode: string) => mode === 'monthly_compounding';

/** The date `months` after `start`, on `dayOfMonth` (clamped to the month's end). */
function addMonths(start: Date, months: number, dayOfMonth: number): Date {
  const d = new Date(start.getFullYear(), start.getMonth() + months, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dayOfMonth, last));
  return d;
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function statusOf(s: string): { label: string; tag: string } {
  switch (s) {
    case 'active': return { label: 'Active', tag: 'tag-active' };
    case 'pending':
    case 'pending_approval': return { label: 'Awaiting Approval', tag: 'tag-awaiting' };
    case 'matured': return { label: 'Matured', tag: 'tag-closed' };
    case 'withdrawn': return { label: 'Withdrawn', tag: 'tag-closed' };
    default:
      return { label: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), tag: 'tag-awaiting' };
  }
}

export interface ProjectionRow {
  month: number;
  date: string;
  opening: number;
  earned: number;
  closing: number;
  toDate: number;
}

export function projectionRows(data: ProjectionInput, months: number): ProjectionRow[] {
  const compounding = isCompoundingMode(data.roiMode);
  const start = data.createdAt ? new Date(data.createdAt) : null;
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
  const dom = data.payoutDay && data.payoutDay > 0 ? data.payoutDay : (validStart?.getDate() ?? 1);
  const rows: ProjectionRow[] = [];
  let balance = data.investmentAmount;
  let toDate = 0;
  for (let m = 1; m <= months; m++) {
    const earned = Math.round(balance * (data.roiPercentage / 100));
    const closing = compounding ? balance + earned : balance;
    toDate += earned;
    rows.push({
      month: m,
      date: validStart ? isoDay(addMonths(validStart, m, dom)) : '',
      opening: balance,
      earned,
      closing,
      toDate,
    });
    if (compounding) balance = closing;
  }
  return rows;
}

export function buildProjectionHtml(data: ProjectionInput, now: Date = new Date()): string {
  const compounding = isCompoundingMode(data.roiMode);
  const months = Math.min(MAX_MONTHS, data.durationMonths > 0 ? data.durationMonths : 12);
  const rows = projectionRows(data, months);
  const lastRow = rows[rows.length - 1];
  const monthlyReturn = Math.round(data.investmentAmount * (data.roiPercentage / 100));
  const totalProjected = lastRow ? lastRow.toDate : 0;
  // A payout account gets the contribution back on top of the returns paid
  // out; a compounding account ends on the grown balance, which includes it.
  const valueAtMaturity = compounding
    ? (lastRow ? lastRow.closing : data.investmentAmount)
    : data.investmentAmount + totalProjected;

  const stamp = isoDay(now);
  const code = data.portfolioCode;
  const ref = `W-PRJ-${stamp.slice(0, 4)}-${stamp.slice(5, 7)}${stamp.slice(8, 10)}`;
  const holder = (data.ownerName ?? '').trim() || 'Supporter';
  const holderUp = holder.toUpperCase();
  const st = statusOf(data.status);
  const methodWords = compounding ? 'Return added to your balance each month' : 'Return paid to you each month';
  const typeWords = compounding ? 'Compound' : 'Monthly Payout';
  const termText = `${months} month${months === 1 ? '' : 's'}`;
  const endDate = data.maturityDate ?? lastRow?.date;
  const period = data.createdAt ? `${day(data.createdAt)} to ${day(endDate)}` : termText;

  const header = reportHeaderHtml({
    meta: [
      { label: 'Account Number', value: code, mono: true },
      { label: 'Report Date', value: day(stamp), date: true },
      { label: 'Term Covered', value: period },
      { label: 'Projection Ref', value: ref, mono: true },
    ],
    customerName: holderUp,
    customerLines: [
      ...(data.accountName ? [`Account Name: ${esc(data.accountName)}`] : []),
      `Account Status: <span class="status-tag ${st.tag}">${esc(st.label)}</span>`,
      'Reporting Currency: UGX (Uganda Shilling)',
    ],
    branch: '<Welile Partner Portfolio Division>',
    summary: [
      { label: 'Contribution:', valueHtml: esc(ugx(data.investmentAmount)) },
      { label: `Monthly Return (${n(data.roiPercentage)}%):`, valueHtml: esc(ugx(monthlyReturn)) },
      { label: `Projected Returns (${termText}):`, valueHtml: esc(ugx(totalProjected)) },
      { label: 'Projected Value at Maturity:', valueHtml: esc(ugx(valueAtMaturity)), closing: true },
      { label: 'Returns Earned to Date:', valueHtml: esc(ugx(data.totalRoiEarned)) },
    ],
  });

  const note = `<div class="statement-disclosure-block">
  <div class="disclosure-title">About This Projection</div>
  <div class="disclosure-body">
    This report shows what this account is expected to earn over its term at the current monthly return rate of <strong>${n(data.roiPercentage)}%</strong>,
    assuming it stays in place for the full ${esc(termText)}. ${compounding
      ? 'Each month&rsquo;s return is added to the balance, so the next return is worked out on the larger amount.'
      : 'Each month&rsquo;s return is paid out to you, and the contribution stays unchanged and is returned at the end of the term.'}
    It is an illustration of expected earnings, not a record of past activity &mdash; for what has actually happened on this account, download the Statement.
  </div>
</div>`;

  const bodyRows = (chunk: ProjectionRow[]) => chunk.map((r) => `<tr>
        <td class="text-center text-muted font-mono">${r.month}</td>
        <td class="date">${day(r.date)}</td>
        <td class="text-right num">${esc(ugx(r.opening))}</td>
        <td class="text-right num font-semibold text-primary">${esc(ugx(r.earned))}</td>
        <td class="text-muted">${compounding ? 'Added to balance' : 'Paid to you'}</td>
        <td class="text-right num">${esc(ugx(r.toDate))}</td>
        <td class="text-right num font-semibold">${esc(ugx(r.closing))}</td>
      </tr>`).join('');

  const scheduleHead = `<thead><tr>
      <th style="width:6%;" class="text-center">#</th>
      <th style="width:15%;">Return Date</th>
      <th class="text-right">Opening Balance</th>
      <th class="text-right">Monthly Return</th>
      <th style="width:16%;">How It Is Treated</th>
      <th class="text-right">Returns to Date</th>
      <th class="text-right">Closing Balance</th>
    </tr></thead>`;
  const scheduleFoot = `<tfoot><tr>
      <td colspan="3" class="text-right font-bold" style="text-transform: uppercase;">Total Projected Returns (${esc(termText)}):</td>
      <td class="text-right num font-bold text-primary">${esc(ugx(totalProjected))}</td>
      <td></td>
      <td class="text-right num font-bold">${esc(ugx(totalProjected))}</td>
      <td class="text-right num font-bold">${esc(ugx(valueAtMaturity))}</td>
    </tr></tfoot>`;

  const accountBlock = (chunk: ProjectionRow[], first: boolean, last: boolean) => `<div class="portfolio-statement-entry">
  ${first ? `<div class="portfolio-banner">
    <div class="portfolio-banner-left">
      <span class="entry-code">${esc(code)}</span>
      <span class="status-tag ${st.tag}">${esc(st.label)}</span>
      <span class="type-tag">${typeWords}</span>
    </div>
    <div class="portfolio-banner-right">
      <span><span class="banner-metric-label">Contribution:</span> <strong class="num">${esc(ugx(data.investmentAmount))}</strong></span>
      <span class="banner-sep">&bull;</span>
      <span><span class="banner-metric-label">Rate:</span> <strong class="num">${n(data.roiPercentage)}%</strong></span>
      <span class="banner-sep">&bull;</span>
      <span><span class="banner-metric-label">Projected Value:</span> <strong class="num text-primary" style="font-size:8px;">${esc(ugx(valueAtMaturity))}</strong></span>
    </div>
  </div>
  <table class="portfolio-terms-table">
    <thead><tr>
      <th style="width:14%;">Start Date</th><th style="width:11%;">Term</th><th style="width:14%;">Maturity Date</th>
      <th style="width:14%;">Next Return Date</th><th style="width:13%;">Monthly Return Rate</th><th>Return Method</th>
    </tr></thead>
    <tbody><tr>
      <td class="date">${day(data.createdAt)}</td>
      <td>${esc(termText)}</td>
      <td class="date">${day(endDate)}</td>
      <td class="date">${day(data.nextRoiDate)}</td>
      <td class="num font-bold">${n(data.roiPercentage)}%</td>
      <td>${esc(methodWords)}</td>
    </tr></tbody>
  </table>` : ''}
  <div class="section-header-bar" style="margin: 6px 6px 3px 6px;">
    <span class="section-title">Projection Schedule${first ? '' : ' (continued)'}</span>
    <span class="section-subtitle">Month by month, at the current monthly return rate</span>
  </div>
  <table class="entry-ledger-table">
    ${scheduleHead}
    <tbody>${bodyRows(chunk)}</tbody>
    ${last ? scheduleFoot : ''}
  </table>
</div>`;

  // The first page holds the header; long terms continue on pages of their own.
  const chunks: ProjectionRow[][] = [rows.slice(0, PAGE1_ROWS)];
  for (let i = PAGE1_ROWS; i < rows.length; i += CONT_ROWS) chunks.push(rows.slice(i, i + CONT_ROWS));

  const completion = `<div class="statement-completion-panel">
  <div class="completion-panel-header">
    <span class="completion-title">Please Note</span>
    <span class="font-mono text-muted" style="font-size:7px;">REF: ${esc(ref)}</span>
  </div>
  <div class="completion-body">
    <p>This projection was prepared for <strong>${esc(holderUp)}</strong> on <strong>${day(stamp)}</strong> from the terms recorded on account <strong>${esc(code)}</strong> with Welile Technologies Limited. Return dates fall on the account&rsquo;s monthly return day. Figures are rounded to the nearest shilling and will change if the account terms change.</p>
    <div class="completion-contact-row">
      <span><strong>Partner Office:</strong> ${WELILE_PARTNER_EMAIL}</span><span>&bull;</span>
      <span><strong>Partner Portal:</strong> welileapp.com</span><span>&bull;</span>
      <span><strong>Head Office:</strong> ${WELILE_OFFICE}</span>
    </div>
  </div>
</div>`;

  const total = chunks.length;
  const pages = chunks.map((chunk, i) => {
    const first = i === 0;
    const last = i === chunks.length - 1;
    return `<article class="report-page page-section">
  <div class="page-content">
    ${first ? `${header}${note}` : runningHeaderHtml({
      title: 'ACCOUNT PROJECTION REPORT &mdash; SCHEDULE',
      accountLabel: 'Account', accountValue: code,
      holderLabel: 'Supporter', holder: holderUp, date: day(stamp), page: i + 1, total,
    })}
    <div class="portfolio-schedule-list">
      ${accountBlock(chunk, first, last)}
      ${last ? completion : ''}
    </div>
  </div>
  ${reportFooterHtml({
    docName: 'ACCOUNT PROJECTION REPORT', ref, page: i + 1, total,
    confidential: 'CONFIDENTIAL ACCOUNT PROJECTION',
  })}
</article>`;
  });

  return reportDocumentHtml(`Welile — Projection Report — ${holder}`, pages);
}
