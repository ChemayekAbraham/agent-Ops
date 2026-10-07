import { supabase } from '@/integrations/supabase/client';
import welileLogoUrl from '@/assets/welile-logo.png';
import { DASH, esc, n, num, printReportHtml, ugx } from './welileReportDocument';
import { PARTNER_STATEMENT_CSS } from './partnerStatementStyles';

export interface StatementCompound { date: string; amount: number; reference: string | null }
export interface StatementPayout { date: string; amount: number; reference: string | null }
export interface StatementChange { date: string; what: string }

export interface StatementPortfolio {
  id: string;
  code: string | null;
  name: string | null;
  status: string;
  roi_mode: string | null;
  rate: number;
  current_value: number;
  start_date: string;
  maturity_date: string | null;
  days_left: number | null;
  next_roi_date: string | null;
  duration_months: number | null;
  auto_reinvest: boolean;
  compounds: StatementCompound[];
  renewals: { date: string }[];
  changes: StatementChange[];
  payouts: StatementPayout[];
}

export interface StatementData {
  generated_at: string;
  partner: { name: string | null; phone: string | null; mobile_money: string | null } | null;
  payouts_total: { count: number; amount: number };
  portfolios: StatementPortfolio[];
  error?: string;
}

/** Fetch the signed-in partner's statement. Omit the id for every portfolio. */
export async function fetchPartnerStatement(portfolioId?: string): Promise<StatementData> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'my_portfolio_statement', { p_portfolio_id: portfolioId ?? null },
  );
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Partial<StatementData>;
  if (d.error) throw new Error('Please sign in again to download your statement.');
  return {
    generated_at: d.generated_at ?? new Date().toISOString(),
    partner: d.partner ?? null,
    payouts_total: d.payouts_total ?? { count: 0, amount: 0 },
    portfolios: Array.isArray(d.portfolios) ? d.portfolios : [],
  };
}

/* ───────────────────────────── presentation ────────────────────────────── */
// Layout follows the approved statement template (see partnerStatementStyles.ts):
// page 1 = account header + balance summary + master schedule of every
// portfolio; the following pages = one ledger block per portfolio.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const day = (v: string | null | undefined): string => {
  const s = String(v ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return DASH;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
};

const STATUS: Record<string, { label: string; tag: string }> = {
  active: { label: 'Active', tag: 'tag-active' },
  cancelled: { label: 'Closed', tag: 'tag-closed' },
  awaiting_partner_details: { label: 'Awaiting Details', tag: 'tag-awaiting' },
  locked: { label: 'Locked', tag: 'tag-awaiting' },
  pending_ops_approval: { label: 'Processing', tag: 'tag-awaiting' },
};
const statusOf = (s: string) => STATUS[s] ?? {
  label: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  tag: 'tag-awaiting',
};
const statusTag = (s: string) => {
  const st = statusOf(s);
  return `<span class="status-tag ${st.tag}">${esc(st.label)}</span>`;
};

const isSelfSupport = (p: StatementPortfolio) => {
  const code = p.code ?? '';
  return code.startsWith('WSP') || code.startsWith('WSH');
};
const isCompound = (p: StatementPortfolio) => (p.roi_mode ?? '').includes('compound');

/** Compound, Payout or Self support, in the supporter's own words. */
export function typeOf(p: StatementPortfolio): string {
  if (isSelfSupport(p)) return 'Self Support';
  return isCompound(p) ? 'Compound' : 'Payout';
}
const typeLabel = (p: StatementPortfolio) => {
  const t = typeOf(p);
  return t === 'Payout' ? 'Monthly Payout' : t;
};

function modeWords(p: StatementPortfolio): string {
  if (isSelfSupport(p)) return 'Self support';
  return isCompound(p) ? 'Return added to your balance each month' : 'Return paid to you each month';
}

const compoundedOf = (p: StatementPortfolio) =>
  (p.compounds ?? []).reduce((s, c) => s + n(c.amount), 0);
const principalOf = (p: StatementPortfolio) =>
  Math.max(0, n(p.current_value) - compoundedOf(p));
const monthlyOf = (p: StatementPortfolio) =>
  Math.round(principalOf(p) * n(p.rate) / 100);
const payoutsOf = (p: StatementPortfolio) =>
  (p.payouts ?? []).reduce((s, w) => s + n(w.amount), 0);

const codeOf = (p: StatementPortfolio) => p.code ?? p.id.slice(0, 8);

/* ─────────────────────────── per-portfolio ledger ────────────────────────── */

interface LedgerRow {
  date: string;
  ref: string | null;
  what: string; // already-escaped HTML
  type: string;
  amount: string | null;
  accent: boolean;
}

function ledgerRows(p: StatementPortfolio): LedgerRow[] {
  const opening: LedgerRow = {
    date: p.start_date, ref: null,
    what: '<strong>Portfolio Opened</strong> &mdash; Initial Capital Contribution',
    type: 'Capital Inflow', amount: ugx(principalOf(p)), accent: false,
  };
  const rest: LedgerRow[] = [];
  for (const c of p.compounds ?? []) {
    rest.push({ date: c.date, ref: c.reference, what: 'Compounded Return Added to Portfolio',
      type: 'Compounded Return', amount: ugx(c.amount), accent: true });
  }
  for (const w of p.payouts ?? []) {
    rest.push({ date: w.date, ref: w.reference, what: 'Payout to Partner',
      type: 'Payout (Money Out)', amount: ugx(w.amount), accent: false });
  }
  for (const r of p.renewals ?? []) {
    rest.push({ date: r.date, ref: null, what: 'Term Renewed', type: 'Update', amount: null, accent: false });
  }
  for (const c of p.changes ?? []) {
    rest.push({ date: c.date, ref: null, what: esc(c.what), type: 'Update', amount: null, accent: false });
  }
  // The opening row stays first; everything else in date order.
  rest.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return [opening, ...rest];
}

function portfolioEntry(p: StatementPortfolio, hasAccountPayouts: boolean): string {
  const rows = ledgerRows(p);
  const returnsAdded = compoundedOf(p);
  const paidOut = payoutsOf(p);
  const term = p.duration_months == null ? DASH : `${p.duration_months} months`;

  const body = rows.map((r) => `<tr>
        <td class="date">${day(r.date)}</td>
        <td class="font-mono text-muted">${r.ref ? esc(r.ref) : '&mdash;'}</td>
        <td>${r.what}</td>
        <td class="text-muted">${esc(r.type)}</td>
        <td class="text-right num font-semibold${r.accent ? ' text-primary' : ''}">${r.amount ?? '&mdash;'}</td>
      </tr>`).join('');

  const foot = [
    returnsAdded > 0
      ? `<tr><td colspan="4" class="text-right font-bold" style="text-transform: uppercase;">Total Compounded Returns:</td><td class="text-right num font-bold text-primary">${ugx(returnsAdded)}</td></tr>`
      : '',
    paidOut > 0
      ? `<tr><td colspan="4" class="text-right font-bold" style="text-transform: uppercase;">Total Payouts:</td><td class="text-right num font-bold">${ugx(paidOut)}</td></tr>`
      : '',
  ].join('');

  const notes = [
    hasAccountPayouts ? '* Payouts not linked to a portfolio are shown at account level (see Statement Note on Page 1)' : '',
    returnsAdded <= 0 && paidOut <= 0 ? 'No Return has been added to this portfolio yet.' : '',
  ].filter(Boolean).join('&nbsp;&bull;&nbsp; ');

  return `<div class="portfolio-statement-entry">
  <div class="portfolio-banner">
    <div class="portfolio-banner-left">
      <span class="entry-code">${esc(codeOf(p))}</span>
      ${statusTag(p.status)}
      <span class="type-tag">${esc(typeLabel(p))}</span>
      <span class="text-muted font-mono" style="font-size:6.8px;">Ref: ${esc(p.id.slice(0, 8))}</span>
    </div>
    <div class="portfolio-banner-right">
      <span><span class="banner-metric-label">Principal:</span> <strong class="num">${ugx(principalOf(p))}</strong></span>
      <span class="banner-sep">&bull;</span>
      <span><span class="banner-metric-label">Rate:</span> <strong class="num">${n(p.rate)}%</strong></span>
      <span class="banner-sep">&bull;</span>
      <span><span class="banner-metric-label">Current Value:</span> <strong class="num text-primary" style="font-size:8px;">${ugx(p.current_value)}</strong></span>
    </div>
  </div>
  <table class="portfolio-terms-table">
    <thead><tr>
      <th style="width:14%;">Start Date</th><th style="width:11%;">Term</th><th style="width:14%;">Maturity Date</th>
      <th style="width:10%;">Days Left</th><th style="width:13%;">Monthly Return Rate</th><th>Return Method</th>
    </tr></thead>
    <tbody><tr>
      <td class="date">${day(p.start_date)}</td>
      <td>${esc(term)}</td>
      <td class="date">${day(p.maturity_date)}</td>
      <td class="num">${p.days_left == null ? DASH : num(p.days_left)}</td>
      <td class="num font-bold">${n(p.rate)}%</td>
      <td>${esc(modeWords(p))}</td>
    </tr></tbody>
  </table>
  <table class="entry-ledger-table">
    <thead><tr>
      <th style="width:14%;">Date</th><th style="width:20%;">Reference</th><th>Activity &amp; Description</th>
      <th style="width:16%;">Type</th><th class="text-right" style="width:16%;">Amount</th>
    </tr></thead>
    <tbody>${body}</tbody>
    ${foot ? `<tfoot>${foot}</tfoot>` : ''}
  </table>
  <div class="entry-footnote-row">
    <span>${notes}</span>
    <span class="font-mono text-muted">Portfolio ID: ${esc(codeOf(p))}</span>
  </div>
</div>`;
}

/* ───────────────────────────── Pagination ────────────────────────────── */
// Heights are estimates in CSS px (a page holds ~1000px of content). They are
// deliberately a little generous so a block is never cut at a page edge.

const SHEET_PX = 1000;
const PAGE1_CHROME_PX = 330;   // header, balance summary, note, schedule head/foot
const SCHEDULE_ROW_PX = 17;
const CONT_CHROME_PX = 60;     // running header on continuation pages
const ENTRY_BASE_PX = 100;     // banner + terms + ledger head + footnote + gap
const ENTRY_ROW_PX = 15;
const COMPLETION_PX = 95;

const entryCost = (p: StatementPortfolio) =>
  ENTRY_BASE_PX
  + (ledgerRows(p).length + (compoundedOf(p) > 0 ? 1 : 0) + (payoutsOf(p) > 0 ? 1 : 0)) * ENTRY_ROW_PX;

function paginateEntries(ps: StatementPortfolio[]): { pages: StatementPortfolio[][]; lastUsed: number } {
  const pages: StatementPortfolio[][] = [];
  let current: StatementPortfolio[] = [];
  let used = 0;
  const budget = SHEET_PX - CONT_CHROME_PX;
  for (const p of ps) {
    const cost = entryCost(p);
    if (current.length && used + cost > budget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(p);
    used += cost;
  }
  if (current.length) pages.push(current);
  return { pages, lastUsed: used };
}

/* ───────────────────────────── the document ────────────────────────────── */

export function buildPartnerStatementHtml(d: StatementData): string {
  const ps = d.portfolios;
  const totalPrincipal = ps.reduce((s, p) => s + principalOf(p), 0);
  const totalCompounded = ps.reduce((s, p) => s + compoundedOf(p), 0);
  const totalValue = ps.reduce((s, p) => s + n(p.current_value), 0);
  const totalMonthly = ps.reduce((s, p) => s + monthlyOf(p), 0);
  const active = ps.filter((p) => p.status === 'active').length;
  const hasAccountPayouts = d.payouts_total.count > 0;

  const stamp = String(d.generated_at).slice(0, 10);
  const who = (d.partner?.name ?? '').trim() || 'Partner';
  const whoUp = who.toUpperCase();
  const accountNo = d.partner?.phone ?? d.partner?.mobile_money ?? DASH;
  const ref = `W-PPS-${stamp.slice(0, 4)}-${stamp.slice(5, 7)}${stamp.slice(8, 10)}`;
  const starts = ps.map((p) => String(p.start_date ?? '').slice(0, 10)).filter(Boolean).sort();
  const period = starts.length ? `${day(starts[0])} to ${day(stamp)}` : day(stamp);

  // "19 Active, 1 Awaiting Details, 7 Closed"
  const counts = new Map<string, number>();
  for (const p of ps) {
    const label = statusOf(p.status).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const countsText = Array.from(counts, ([label, c]) => `${c} ${label}`).join(', ');

  const footer = (i: number, total: number) => `<footer class="report-footer">
    <span class="footer-left">WELILE TECHNOLOGIES LIMITED &bull; CONFIDENTIAL FINANCIAL STATEMENT</span>
    <span class="footer-center">PARTNER PORTFOLIO STATEMENT &bull; REF: ${esc(ref)}</span>
    <span class="footer-right">PAGE ${i} OF ${total} &bull; welileapp.com</span>
  </footer>`;

  const header = `<header class="bank-statement-header">
  <div class="header-top-container">
    <div class="header-right-block">
      <div class="header-bank-identity">
        <img src="${welileLogoUrl}" alt="Welile" class="bank-logo" />
        <div class="bank-address-block">
          <div class="bank-company-name">Welile Technologies Limited</div>
          <div>Palm Lane Kabaale, Entebbe Uganda</div>
          <div>partnership@welile.com &bull; welileapp.com</div>
        </div>
      </div>
      <div class="account-meta-block">
        <div class="meta-line"><span class="meta-lbl">Account Number:</span> <span class="meta-val font-mono">${esc(accountNo)}</span></div>
        <div class="meta-line"><span class="meta-lbl">Statement Date:</span> <span class="meta-val date">${day(stamp)}</span></div>
        <div class="meta-line"><span class="meta-lbl">Period Covered:</span> <span class="meta-val">${esc(period)}</span></div>
        <div class="meta-line"><span class="meta-lbl">Statement Ref:</span> <span class="meta-val font-mono">${esc(ref)}</span></div>
      </div>
    </div>
  </div>
  <div class="header-summary-row">
    <div class="customer-info-col">
      <div class="customer-name">${esc(whoUp)}</div>
      ${d.partner?.mobile_money ? `<div class="customer-detail">Mobile Money: ${esc(d.partner.mobile_money)}</div>` : ''}
      <div class="customer-detail">Account Status: ${active > 0
        ? '<span class="status-tag tag-active">Active Partner</span>'
        : '<span class="status-tag tag-closed">No active portfolios</span>'}</div>
      <div class="customer-detail">Reporting Currency: UGX (Uganda Shilling)</div>
      <div class="customer-branch">&lt;Welile Partner Portfolio Division&gt;</div>
    </div>
    <div class="balance-summary-col">
      <table class="balance-summary-table">
        <tr><td class="bal-lbl">Opening / Capital Supported:</td><td class="bal-val num">${esc(ugx(totalPrincipal))}</td></tr>
        <tr><td class="bal-lbl">Total Credit (Compounded Returns):</td><td class="bal-val num">${esc(ugx(totalCompounded))}</td></tr>
        <tr><td class="bal-lbl">Total Debit (Payouts to Date):</td><td class="bal-val num">${esc(ugx(d.payouts_total.amount))}</td></tr>
        <tr class="closing-balance-row">
          <td class="bal-lbl font-bold" style="color:var(--text-main);">Closing / Total Portfolio Value:</td>
          <td class="bal-val num font-bold" style="font-size:9.5px; color:var(--text-main);">${esc(ugx(totalValue))}</td>
        </tr>
        <tr><td class="bal-lbl">Number of Portfolios:</td>
          <td class="bal-val num font-bold">${ps.length} <span class="text-muted" style="font-size:6.8px; font-weight:normal;">(${esc(countsText)})</span></td></tr>
      </table>
    </div>
  </div>
</header>`;

  const note = `<div class="statement-disclosure-block">
  <div class="disclosure-title">Statement Note &amp; Payout Accounting Disclosure</div>
  <div class="disclosure-body">
    ${hasAccountPayouts
      ? `${num(d.payouts_total.count)} payout${d.payouts_total.count === 1 ? '' : 's'} totalling <strong>${esc(ugx(d.payouts_total.amount))}</strong> ${d.payouts_total.count === 1 ? 'is' : 'are'} recorded on this account. A payout appears against an individual portfolio only when it is linked to that disbursement; the rest are recorded at account level. Individual portfolio values reflect recorded principal and compounded return activity, and should not be read as balances after unallocated withdrawals.`
      : 'No payouts have been recorded on this account. Individual portfolio values reflect recorded principal and compounded return activity.'}
  </div>
</div>`;

  const scheduleRows = ps.map((p, i) => `<tr>
    <td class="text-center text-muted font-mono">${i + 1}</td>
    <td class="font-mono font-bold">${esc(codeOf(p))}</td>
    <td class="text-center">${statusTag(p.status)}</td>
    <td class="text-center"><span class="type-tag">${esc(typeLabel(p))}</span></td>
    <td class="text-right num">${n(p.rate)}%</td>
    <td class="text-right num">${esc(ugx(principalOf(p)))}</td>
    <td class="text-right num text-body">${esc(ugx(monthlyOf(p)))}</td>
    <td class="text-right num font-bold text-primary">${esc(ugx(p.current_value))}</td>
    <td class="text-center date">${day(p.start_date)}</td>
    <td class="text-center date">${day(p.maturity_date)}</td>
    <td class="text-center num">${p.days_left == null ? DASH : num(p.days_left)}</td>
  </tr>`);

  const SCHEDULE_HEAD = `<tr>
    <th style="width:20px;" class="text-center">#</th>
    <th style="width:85px;">Portfolio Code</th>
    <th style="width:75px;" class="text-center">Status</th>
    <th style="width:75px;" class="text-center">Type</th>
    <th class="text-right" style="width:40px;">Rate</th>
    <th class="text-right">Principal</th>
    <th class="text-right">Monthly Return</th>
    <th class="text-right">Current Value</th>
    <th class="text-center">Start Date</th>
    <th class="text-center">Maturity</th>
    <th class="text-center" style="width:45px;">Days Left</th>
  </tr>`;
  const scheduleFoot = `<tr>
    <td colspan="4" class="text-right font-bold" style="text-transform:uppercase;">Totals (${ps.length} Portfolio${ps.length === 1 ? '' : 's'}):</td>
    <td class="text-right num font-bold">&mdash;</td>
    <td class="text-right num font-bold">${esc(ugx(totalPrincipal))}</td>
    <td class="text-right num font-bold">${esc(ugx(totalMonthly))}</td>
    <td class="text-right num font-bold text-primary">${esc(ugx(totalValue))}</td>
    <td colspan="3" class="text-center text-muted" style="font-size:7px;">${esc(countsText.replace(/, /g, ' • '))}</td>
  </tr>`;

  // Schedule rows that do not fit on page 1 continue on pages of their own.
  const firstCap = Math.max(8, Math.floor((SHEET_PX - PAGE1_CHROME_PX) / SCHEDULE_ROW_PX));
  const contCap = Math.floor((SHEET_PX - CONT_CHROME_PX - 60) / SCHEDULE_ROW_PX);
  const scheduleChunks: string[][] = [scheduleRows.slice(0, firstCap)];
  for (let i = firstCap; i < scheduleRows.length; i += contCap) {
    scheduleChunks.push(scheduleRows.slice(i, i + contCap));
  }

  // The completion panel closes the last page; if it will not fit there, it gets one.
  const { pages: entryChunks, lastUsed } = paginateEntries(ps);
  const panelOnOwnPage = lastUsed + COMPLETION_PX > SHEET_PX - CONT_CHROME_PX;
  const total = scheduleChunks.length + entryChunks.length + (panelOnOwnPage ? 1 : 0);

  const running = (title: string, pageNo: number) => `<header class="detail-running-header">
  <div class="running-header-left">
    <img src="${welileLogoUrl}" alt="Welile" class="running-logo" />
    <div class="running-company-info">
      <span class="running-company-name">Welile Technologies Limited</span>
      <span class="running-contact">Palm Lane Kabaale, Entebbe Uganda &bull; partnership@welile.com</span>
    </div>
  </div>
  <div class="running-header-right">
    <div class="running-doc-title">${title}</div>
    <div class="running-meta-line">
      <span><strong>Account:</strong> ${esc(accountNo)}</span><span>&bull;</span>
      <span><strong>Partner:</strong> ${esc(whoUp)}</span><span>&bull;</span>
      <span><strong>Date:</strong> ${day(stamp)}</span><span>&bull;</span>
      <span><strong>Page ${pageNo} of ${total}</strong></span>
    </div>
  </div>
</header>`;

  const completion = `<div class="statement-completion-panel">
  <div class="completion-panel-header">
    <span class="completion-title">Official Statement Completion Verification</span>
    <span class="font-mono text-muted" style="font-size:7px;">REF: ${esc(ref)}</span>
  </div>
  <div class="completion-body">
    <p>This document constitutes the complete Partner Portfolio Statement for <strong>${esc(whoUp)}</strong> covering all ${ps.length} registered portfolio${ps.length === 1 ? '' : 's'} as of <strong>${day(stamp)}</strong>. All recorded capital contributions, contractual return rates, compounded additions, and holding balances are maintained under the financial administration of Welile Technologies Limited.</p>
    <div class="completion-contact-row">
      <span><strong>Partner Office:</strong> partnership@welile.com</span><span>&bull;</span>
      <span><strong>Partner Portal:</strong> welileapp.com</span><span>&bull;</span>
      <span><strong>Head Office:</strong> Palm Lane Kabaale, Entebbe Uganda</span>
    </div>
  </div>
</div>`;

  const schedulePages = scheduleChunks.map((rows, i) => {
    const lastChunk = i === scheduleChunks.length - 1;
    const section = `<section>
      <div class="section-header-bar">
        <span class="section-title">${i === 0
          ? `Master Portfolio Schedule (All ${ps.length} Registered Portfolio${ps.length === 1 ? '' : 's'})`
          : 'Master Portfolio Schedule (continued)'}</span>
        <span class="section-subtitle">Principal, return rates, monthly earnings and maturities</span>
      </div>
      <div class="master-table-wrapper">
        <table class="master-schedule-table">
          <thead>${SCHEDULE_HEAD}</thead>
          <tbody>${rows.join('')}</tbody>
          ${lastChunk ? `<tfoot>${scheduleFoot}</tfoot>` : ''}
        </table>
      </div>
    </section>`;
    return `<article class="report-page">
  <div class="page-content">
    ${i === 0 ? `${header}${note}` : running('STATEMENT OF ACCOUNT &mdash; MASTER SCHEDULE', i + 1)}
    ${section}
  </div>
  ${footer(i + 1, total)}
</article>`;
  });

  const entryPages = entryChunks.map((chunk, i) => {
    const pageNo = scheduleChunks.length + i + 1;
    const isLast = i === entryChunks.length - 1;
    return `<article class="report-page">
  <div class="page-content">
    ${running('STATEMENT OF ACCOUNT &mdash; PORTFOLIO SCHEDULES', pageNo)}
    <div class="portfolio-schedule-list">
      ${chunk.map((p) => portfolioEntry(p, hasAccountPayouts)).join('\n')}
      ${isLast && !panelOnOwnPage ? completion : ''}
    </div>
  </div>
  ${footer(pageNo, total)}
</article>`;
  });

  const panelPage = panelOnOwnPage
    ? [`<article class="report-page">
  <div class="page-content">
    ${running('STATEMENT OF ACCOUNT &mdash; COMPLETION', total)}
    <div class="portfolio-schedule-list">${completion}</div>
  </div>
  ${footer(total, total)}
</article>`]
    : [];

  const baseTag = typeof window !== 'undefined' && window.location?.origin
    ? `<base href="${window.location.origin}/">`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
${baseTag}
<title>${esc(`Welile — Partner Portfolio Statement — ${who}`)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${PARTNER_STATEMENT_CSS}</style>
</head><body>
<main class="document-wrapper">${[...schedulePages, ...entryPages, ...panelPage].join('\n')}</main>
<script>window.__WELILE_READY__ = true;</script>
</body></html>`;
}

/**
 * Build the statement and print it.
 */
export async function downloadPartnerStatement(portfolioId?: string): Promise<void> {
  const data = await fetchPartnerStatement(portfolioId);
  if (data.portfolios.length === 0) {
    throw new Error('There are no portfolios to put in a statement yet.');
  }
  const html = buildPartnerStatementHtml(data);
  const who = (data.partner?.name ?? 'supporter').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const scope = portfolioId
    ? (data.portfolios[0].code ?? portfolioId.slice(0, 8))
    : 'all-portfolios';
  printReportHtml(html, `welile-statement-${who}-${scope}-${String(data.generated_at).slice(0, 10)}`);
}
