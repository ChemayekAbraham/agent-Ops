/**
 * The partner portfolio statement.
 *
 * A record of what actually happened: every portfolio, what was put in, the
 * Returns added to it, money taken out, renewals and office corrections. That
 * is a different document from the projection PDF, which shows what a
 * portfolio is *expected* to earn — one looks back, the other forward, and a
 * partner usually wants to be asked which.
 *
 * Built as an HTML document on the shared Welile report kit
 * (`welileReportDocument.ts`) and printed to PDF, exactly like the Agent
 * Operations reports. That is the house contract: the document the partner
 * sees IS the document that prints, on the same stylesheet as every other
 * report. An earlier version of this file drew itself in jsPDF instead, which
 * is why it came out looking like a generic table dump rather than a Welile
 * report.
 *
 * Read-only. `my_portfolio_statement` proves ownership from `auth.uid()`, so
 * the browser cannot ask for anyone else's portfolios.
 */
import { supabase } from '@/integrations/supabase/client';
import {
  DASH,
  docHeader,
  esc,
  kpiGrid,
  n,
  num,
  page,
  printReportHtml,
  sectionTitle,
  shell,
  table,
  ugx,
} from './welileReportDocument';

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a date the server already resolved to a calendar day.
 *
 * Deliberately string-only: `new Date('2026-03-05')` is parsed as UTC midnight
 * and then rendered in the reader's zone, which shows the previous day to
 * anyone west of Greenwich. A contribution date must not move because of where
 * the statement is opened.
 */
const day = (v: string | null | undefined): string => {
  const s = String(v ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return DASH;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
};

const STATUS: Record<string, string> = {
  active: 'Active',
  cancelled: 'Closed',
  awaiting_partner_details: 'Awaiting your details',
  locked: 'Locked',
  pending_ops_approval: 'Being set up',
};
const statusOf = (s: string) => STATUS[s] ?? s.replace(/_/g, ' ');

const STATUS_BADGE: Record<string, string> = {
  active: 'badge-target',
  cancelled: 'badge-silver',
  awaiting_partner_details: 'badge-warn',
  locked: 'badge-info',
  pending_ops_approval: 'badge-info',
};
const statusBadge = (s: string) =>
  `<span class="doc-badge ${STATUS_BADGE[s] ?? 'badge-silver'}">${esc(statusOf(s))}</span>`;

/** Compound, Payout or Self support, in the partner's own words. */
export function typeOf(p: StatementPortfolio): string {
  const code = p.code ?? '';
  if (code.startsWith('WSP') || code.startsWith('WSH')) return 'Self support';
  return (p.roi_mode ?? '').includes('compound') ? 'Compound' : 'Payout';
}

function modeWords(p: StatementPortfolio): string {
  if (typeOf(p) === 'Self support') return 'Self support';
  return (p.roi_mode ?? '').includes('compound')
    ? 'Return added back each month'
    : 'Return paid to you each month';
}

/* Returns are folded into the balance as they are earned, so what the partner
   actually put in is the balance less those Returns. Showing the two apart is
   the whole point of the statement. */
const compoundedOf = (p: StatementPortfolio) =>
  (p.compounds ?? []).reduce((s, c) => s + n(c.amount), 0);
const principalOf = (p: StatementPortfolio) =>
  Math.max(0, n(p.current_value) - compoundedOf(p));
const monthlyOf = (p: StatementPortfolio) =>
  Math.round(principalOf(p) * n(p.rate) / 100);

const td = (v: string, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${esc(v)}</td>`;
const th = (v: string, cls = '') => `<th${cls ? ` class="${cls}"` : ''}>${esc(v)}</th>`;

/* ─────────────────────────── the detail cards ──────────────────────────── */

function bio(label: string, value: string): string {
  return `<div class="bio-item"><span class="bio-lbl">${esc(label)}</span><span class="bio-val">${esc(value)}</span></div>`;
}

function pill(label: string, value: string): string {
  return `<div class="tenant-kpi-pill"><div class="t-lbl">${esc(label)}</div><div class="t-val num">${esc(value)}</div></div>`;
}

const cap = (t: string) => `<div class="chart-summary-cap">${esc(t)}</div>`;

/** One portfolio, broken down the way the template lays it out. */
function portfolioCard(p: StatementPortfolio): string {
  const principal = principalOf(p);
  const compounded = compoundedOf(p);

  const payouts = table({
    head: `<tr>${th('Date')}${th('Reference')}${th('Amount (UGX)', 'right')}</tr>`,
    rows: (p.payouts ?? []).map(
      (w) => `<tr>${td(day(w.date), 'nowrap')}${td(w.reference ?? DASH)}${td(num(w.amount), 'right num')}</tr>`,
    ),
    colspan: 3,
    emptyText: 'No payout is linked to this portfolio.',
  });

  const topups = table({
    head: `<tr>${th('Date')}${th('What happened')}${th('Amount (UGX)', 'right')}</tr>`,
    rows: [`<tr>${td(day(p.start_date), 'nowrap')}${td('Portfolio opened')}${td(num(principal), 'right num')}</tr>`],
    colspan: 3,
  });

  const compounds = table({
    head: `<tr>${th('Date')}${th('Reference')}${th('Amount (UGX)', 'right')}</tr>`,
    rows: (p.compounds ?? []).map(
      (c) => `<tr>${td(day(c.date), 'nowrap')}${td(c.reference ?? DASH)}${td(num(c.amount), 'right num')}</tr>`,
    ),
    foot: `<tr>${td('Total')}${td('')}${td(num(compounded), 'right num')}</tr>`,
    colspan: 3,
    emptyText: 'No Return has been added to this portfolio yet.',
  });

  const events = [
    ...(p.renewals ?? []).map((r) => ({ date: r.date, what: 'Renewed for another term' })),
    ...(p.changes ?? []),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const changes = table({
    head: `<tr>${th('Date')}${th('What happened')}</tr>`,
    rows: events.map((c) => `<tr>${td(day(c.date), 'nowrap')}${td(c.what)}</tr>`),
    colspan: 2,
    emptyText: 'No renewal or change recorded.',
  });

  return `<div class="tenant-card-block avoid-break">
  <div class="tenant-card-header">
    <div class="tenant-name-title">${esc(p.code ?? p.id.slice(0, 8))} ${statusBadge(p.status)}</div>
    <div class="cell-sub">${esc(`${n(p.rate)}% · ${modeWords(p)}`)}</div>
  </div>
  <div class="tenant-bio-grid">
    ${bio('Contribution date', day(p.start_date))}
    ${bio('Portfolio name', p.name || p.code || DASH)}
    ${bio('Portfolio ID', p.id.slice(0, 8))}
    ${bio('Return rate', `${n(p.rate)}%`)}
    ${bio('Maturity date', day(p.maturity_date))}
    ${bio('Days left', p.days_left == null ? DASH : num(p.days_left))}
    ${bio('Term', p.duration_months == null ? DASH : `${p.duration_months} months`)}
    ${bio('Type', typeOf(p))}
  </div>
  <div class="tenant-kpi-bar">
    ${pill('Principal', ugx(principal))}
    ${pill('Return added', ugx(compounded))}
    ${pill('Return each month', ugx(monthlyOf(p)))}
    ${pill('Worth now', ugx(p.current_value))}
  </div>
  <div style="padding:8px 12px 4px 12px">
    ${cap('Payouts (money taken out)')}${payouts}
    ${cap('Top-ups')}${topups}
    ${cap('Compounds (Return added)')}${compounds}
    ${cap('Renewals & changes')}${changes}
  </div>
</div>`;
}

/**
 * Density rules for this document only.
 *
 * A statement is four small tables per portfolio, most of them empty, and the
 * shared stylesheet's padding is tuned for ops reports with far fewer, denser
 * blocks. Without this a portfolio card runs ~500px and only two fit a sheet,
 * with a third of the page left blank; tightened, the same card is ~440px and
 * the document loses three sheets. Nothing here changes a figure or a colour.
 */
const STATEMENT_CSS = `
.report-table{margin-bottom:6px}
.report-table th{padding:3px 6px}
.report-table td{padding:2px 6px}
.empty-row td{padding:7px 6px}
.pdf-header{padding-bottom:9px;margin-bottom:10px}
.section-title{margin-top:8px;margin-bottom:5px}
.kpi-card{padding:6px 10px}
.entity-card{padding:9px 14px}
.chart-summary-cap{margin-top:4px;margin-bottom:1px}
.tenant-card-block{margin-bottom:10px}
.tenant-bio-grid{padding:6px 12px}
.tenant-kpi-bar{padding:5px 12px}
.entity-card{margin-bottom:8px}
.kpi-grid{margin-bottom:8px}
.observation-callout{margin-top:5px;margin-bottom:0}
`;

/**
 * Pack the detail cards onto A4 sheets.
 *
 * `.report-page` is `overflow:hidden` and carries its own "Page N of M"
 * footer, so a page handed more than a sheet holds does not just look wrong —
 * it spills onto an unnumbered extra sheet. Pagination is therefore explicit.
 *
 * The constants are measured, not guessed: a card rendered under print media
 * at A4 width is a fixed ~400px of chrome (header, bio grid, KPI bar and four
 * table headings) plus ~21px per data row, against ~990px of usable sheet once
 * the page footer is taken off. `scripts/` has no harness for this; the check
 * is that the printed sheet count equals the number of footers.
 */
const CARD_BASE_PX = 400;
const CARD_ROW_PX = 21;
const SHEET_PX = 990;
const SECTION_TITLE_PX = 32;

/* Page 1 spends this much on the document header, the partner card, the four
   figures, the section heading, the totals row and the payouts note, before a
   single portfolio row is drawn. A summary row is shorter than a card row
   because the tightened padding above applies to it. */
const PAGE1_CHROME_PX = 430;
const SUMMARY_ROW_PX = 19;

function paginate(ps: StatementPortfolio[]): StatementPortfolio[][] {
  const out: StatementPortfolio[][] = [];
  let current: StatementPortfolio[] = [];
  let used = 0;
  for (const p of ps) {
    const rows = (p.payouts?.length ?? 0) + (p.compounds?.length ?? 0)
      + (p.renewals?.length ?? 0) + (p.changes?.length ?? 0) + 1;
    const cost = CARD_BASE_PX + rows * CARD_ROW_PX;
    // The first detail page also carries the section heading.
    const budget = SHEET_PX - (out.length === 0 ? SECTION_TITLE_PX : 0);
    if (current.length && used + cost > budget) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(p);
    used += cost;
  }
  if (current.length) out.push(current);
  return out;
}

/* ───────────────────────────── the document ────────────────────────────── */

/** The statement as a standalone printable HTML document. */
export function buildPartnerStatementHtml(d: StatementData): string {
  const ps = d.portfolios;
  const totalPrincipal = ps.reduce((s, p) => s + principalOf(p), 0);
  const totalCompounded = ps.reduce((s, p) => s + compoundedOf(p), 0);
  const totalValue = ps.reduce((s, p) => s + n(p.current_value), 0);
  const totalMonthly = ps.reduce((s, p) => s + monthlyOf(p), 0);
  const active = ps.filter((p) => p.status === 'active').length;

  const stamp = String(d.generated_at).slice(0, 10);
  const who = d.partner?.name ?? 'Partner';
  const ref = `W-PPS-${stamp.replace(/-/g, '')}`;

  const header = docHeader({
    title: 'Partner Portfolio Statement',
    subtitle: 'Everything you have put in, what it has earned, and what it is worth today',
    meta: [
      { label: 'Statement Date', value: day(stamp) },
      { label: 'Statement Ref', value: ref },
      { label: 'Portfolios', value: `${ps.length} · ${active} running` },
      { label: 'Currency', value: 'UGX' },
    ],
  });

  const entity = `<section class="entity-card">
  <div class="entity-info">
    <div class="entity-header-row">
      <span class="entity-eyebrow">Partner</span>
      <span class="doc-badge badge-primary">${esc(`${ps.length} portfolios`)}</span>
    </div>
    <h2>${esc(who)}</h2>
    <div class="entity-phone">${esc(d.partner?.phone ?? DASH)}</div>
    <div class="entity-meta">Mobile money <strong>${esc(d.partner?.mobile_money ?? DASH)}</strong></div>
  </div>
  <div class="entity-stats">
    <div class="entity-stat-pill">
      <span class="label">Total Capital</span>
      <span class="val num">${esc(ugx(totalValue))}</span>
      <span class="stat-sub">${esc(`across ${ps.length} portfolios`)}</span>
    </div>
    <div class="entity-stat-pill">
      <span class="label">Total Payouts</span>
      <span class="val num">${esc(ugx(d.payouts_total.amount))}</span>
      <span class="stat-sub">${esc(`${num(d.payouts_total.count)} payouts`)}</span>
    </div>
  </div>
</section>`;

  const kpis = kpiGrid([
    { label: 'Money You Put In', value: ugx(totalPrincipal), sub: 'your own contributions', variant: 'primary' },
    { label: 'Return Added', value: ugx(totalCompounded), sub: 'folded into your balance', variant: 'success' },
    { label: 'Total Capital', value: ugx(totalValue), sub: 'what it is worth today' },
    { label: 'Return Each Month', value: ugx(totalMonthly), sub: 'at the rates shown' },
  ], 4);

  /* Money is plain here and the unit sits in the column head: eleven columns on
     A4 have no room to repeat "UGX" 81 times, and doing so wraps every figure
     and every date onto a second line. */
  const SUMMARY_HEAD = `<tr>${th('#')}${th('Portfolio')}${th('Status')}${th('Rate', 'right')}${th('Principal (UGX)', 'right')}${th('Return (UGX)', 'right')}${th('Current Value (UGX)', 'right')}${th('Start')}${th('Matures')}${th('Days Left', 'right')}${th('Type')}</tr>`;

  const summaryRows = ps.map((p, i) => {
    const principal = principalOf(p);
    return `<tr>${td(String(i + 1))}${td(p.code ?? p.id.slice(0, 8), 'cell-strong')}${
      `<td>${statusBadge(p.status)}</td>`
    }${td(`${n(p.rate)}%`, 'right')}${td(num(principal), 'right num')}${td(num(monthlyOf(p)), 'right num')}${
      td(num(p.current_value), 'right num cell-strong')
    }${td(day(p.start_date), 'nowrap')}${td(day(p.maturity_date), 'nowrap')}${
      td(p.days_left == null ? DASH : num(p.days_left), 'right')
    }${td(typeOf(p), 'nowrap')}</tr>`;
  });

  const summaryFoot = `<tr class="total-row">${td('')}${td('TOTALS')}${td('')}${td('')}${
    td(num(totalPrincipal), 'right num')}${td(num(totalMonthly), 'right num')}${
    td(num(totalValue), 'right num')}${td('')}${td('')}${td('')}${td('')}</tr>`;

  const caveat = `<div class="observation-callout">
  <strong>About money taken out.</strong> ${esc(
    `${num(d.payouts_total.count)} payouts totalling ${ugx(d.payouts_total.amount)} are recorded on this account. `
    + 'A payout only appears against a portfolio below when it records which portfolio it came from, so '
    + '"Current Value" is the portfolio balance rather than the balance after money was taken out.',
  )}
</div>`;

  /* The summary table is paginated too. Page 1 already spends most of a sheet
     on the header, the partner card and the four figures, so it holds far
     fewer rows than a continuation page — a partner with enough portfolios
     would otherwise push the totals off the bottom of a fixed-height page. */
  const FIRST_PAGE_ROWS = Math.floor((SHEET_PX - PAGE1_CHROME_PX) / SUMMARY_ROW_PX);
  const CONT_PAGE_ROWS = Math.floor((SHEET_PX - SECTION_TITLE_PX) / SUMMARY_ROW_PX);
  const summaryChunks: string[][] = [];
  for (let i = 0; i < summaryRows.length || i === 0;) {
    const size = summaryChunks.length === 0 ? FIRST_PAGE_ROWS : CONT_PAGE_ROWS;
    summaryChunks.push(summaryRows.slice(i, i + size));
    i += size;
    if (i >= summaryRows.length) break;
  }

  const detailChunks = paginate(ps);
  const total = summaryChunks.length + detailChunks.length;
  const foot = (i: number) => `Partner Portfolio Statement | Page ${i} of ${total}`;

  const summaryPages = summaryChunks.map((rows, i) => {
    const last = i === summaryChunks.length - 1;
    const body = table({
      head: SUMMARY_HEAD,
      rows,
      foot: last ? summaryFoot : undefined,
      colspan: 11,
      emptyText: 'No portfolio has been opened on this account yet.',
    });
    const title = i === 0
      ? sectionTitle(`All Your Portfolios (${ps.length})`,
          'Return is what one month earns on the principal, at the rate shown')
      : sectionTitle('All Your Portfolios (continued)');
    return page(
      `${i === 0 ? `${header}${entity}${kpis}` : ''}${title}${body}${last ? caveat : ''}`,
      foot(i + 1),
    );
  });

  const pages = [
    ...summaryPages,
    ...detailChunks.map((chunk, i) =>
      page(
        `${i === 0 ? sectionTitle('Each Portfolio in Detail', 'contributions, payouts, Returns and changes') : ''}${
          chunk.map(portfolioCard).join('')
        }`,
        foot(summaryChunks.length + i + 1),
      ),
    ),
  ];

  return shell({
    title: `Welile — Partner Portfolio Statement — ${who}`,
    pages,
    noCharts: true,
    extraCss: STATEMENT_CSS,
  });
}

/**
 * Build the statement and print it.
 *
 * Printing is what produces the PDF, on the same path the Agent Operations
 * reports use, so the exported file is the document itself rather than a
 * redrawing of it.
 *
 * @param portfolioId omit for every portfolio the partner holds.
 */
export async function downloadPartnerStatement(portfolioId?: string): Promise<void> {
  const data = await fetchPartnerStatement(portfolioId);
  if (data.portfolios.length === 0) {
    throw new Error('There are no portfolios to put in a statement yet.');
  }
  const html = buildPartnerStatementHtml(data);
  const who = (data.partner?.name ?? 'partner').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const scope = portfolioId
    ? (data.portfolios[0].code ?? portfolioId.slice(0, 8))
    : 'all-portfolios';
  printReportHtml(html, `welile-statement-${who}-${scope}-${String(data.generated_at).slice(0, 10)}`);
}
