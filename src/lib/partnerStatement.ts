import { supabase } from '@/integrations/supabase/client';
import welileLogoUrl from '@/assets/welile-logo.png';
import {
  DASH,
  esc,
  n,
  num,
  printReportHtml,
  shell,
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

const day = (v: string | null | undefined): string => {
  const s = String(v ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return DASH;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
};

const STATUS: Record<string, string> = {
  active: 'ACTIVE',
  cancelled: 'CLOSED',
  awaiting_partner_details: 'PENDING DETAILS',
  locked: 'LOCKED',
  pending_ops_approval: 'PROCESSING',
};
const statusOf = (s: string) => STATUS[s] ?? s.replace(/_/g, ' ').toUpperCase();

/** Compound, Payout or Self support, in the supporter's own words. */
export function typeOf(p: StatementPortfolio): string {
  const code = p.code ?? '';
  if (code.startsWith('WSP') || code.startsWith('WSH')) return 'Self Support';
  return (p.roi_mode ?? '').includes('compound') ? 'Compound' : 'Payout';
}

function modeWords(p: StatementPortfolio): string {
  if (typeOf(p) === 'Self Support') return 'Self support';
  return (p.roi_mode ?? '').includes('compound')
    ? 'Return added to balance'
    : 'Return paid monthly';
}

const compoundedOf = (p: StatementPortfolio) =>
  (p.compounds ?? []).reduce((s, c) => s + n(c.amount), 0);
const principalOf = (p: StatementPortfolio) =>
  Math.max(0, n(p.current_value) - compoundedOf(p));
const monthlyOf = (p: StatementPortfolio) =>
  Math.round(principalOf(p) * n(p.rate) / 100);

const td = (v: string, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${esc(v)}</td>`;
const th = (v: string, cls = '') => `<th${cls ? ` class="${cls}"` : ''}>${esc(v)}</th>`;

/* ─────────────────────────── HSBC-style CSS ──────────────────────────── */

const BANK_STATEMENT_CSS = `
body {
  background-color: #E2E8F0;
  font-family: Arial, Helvetica, 'Inter', sans-serif;
  color: #0F172A;
  font-size: 8.5pt;
  line-height: 1.35;
  -webkit-font-smoothing: antialiased;
}
.report-page {
  width: 210mm;
  min-height: 297mm;
  background-color: #FFFFFF;
  padding: 14mm 16mm 14mm 16mm;
  margin-bottom: 24px;
  box-shadow: 0 4px 15px rgba(108,33,196,.08);
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
}
.page-content { flex: 1; }

/* Bank Header */
.bank-header-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
}
.bank-logo-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bank-logo-img {
  height: 40px;
  width: auto;
  border-radius: 6px;
  object-fit: contain;
}
.bank-name-block {
  display: flex;
  flex-direction: column;
}
.bank-main-title {
  font-size: 14pt;
  font-weight: 900;
  letter-spacing: 1px;
  color: #1E1B4B;
}
.bank-sub-title {
  font-size: 7.5pt;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: #7B19D4;
  text-transform: uppercase;
}
.bank-header-right {
  text-align: right;
  font-size: 8pt;
  line-height: 1.3;
}
.bank-statement-red-title {
  font-size: 15pt;
  font-weight: 900;
  color: #7B19D4;
  margin-bottom: 3px;
  letter-spacing: -0.3px;
}
.bank-contact-details {
  color: #334155;
  font-size: 7.5pt;
}

/* Dual Summary Boxes */
.bank-dual-grid {
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: 20px;
  margin-bottom: 12px;
}
.bank-account-box {
  border-top: 2px solid #7B19D4;
  border-bottom: 2px solid #7B19D4;
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.bank-account-box-title {
  font-weight: 800;
  font-size: 9.5pt;
  color: #581C87;
  border-bottom: 1.5px solid #7B19D4;
  padding-bottom: 3px;
  margin-bottom: 3px;
}
.bank-account-row {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid #E2E8F0;
  padding: 2.5px 0;
  font-size: 8pt;
}
.bank-account-row:last-child {
  border-bottom: none;
}
.bank-account-lbl {
  font-style: italic;
  font-weight: 600;
  color: #475569;
}
.bank-account-val {
  font-weight: 700;
  color: #0F172A;
}

/* Balance Table */
.bank-balance-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 7.8pt;
  border: 1.5px solid #7B19D4;
}
.bank-balance-table td {
  border: 1px solid #E2E8F0;
  padding: 2.5px 6px;
  color: #0F172A;
}
.bank-balance-table td.b-val {
  text-align: right;
  font-weight: 700;
}
.bank-balance-table tr.b-closing {
  background-color: #F5F3FF;
  font-weight: 800;
  color: #581C87;
}
.bank-balance-table tr.b-closing td {
  border-top: 1.5px solid #7B19D4;
  border-bottom: 1.5px solid #7B19D4;
  color: #581C87;
}

/* Meta Address Row */
.bank-meta-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  font-size: 8pt;
  margin-top: 8px;
  margin-bottom: 14px;
}
.bank-meta-date {
  font-weight: 700;
  color: #581C87;
  margin-bottom: 6px;
}
.bank-recipient-block {
  line-height: 1.35;
  font-weight: 600;
  color: #0F172A;
}
.bank-meta-right {
  text-align: right;
  line-height: 1.35;
  color: #334155;
}

/* Section Bar */
.bank-section-bar {
  border-top: 2.5px solid #7B19D4;
  padding-top: 3px;
  margin-top: 10px;
  margin-bottom: 4px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.bank-section-bar h2 {
  font-size: 11pt;
  font-weight: 900;
  margin: 0;
  color: #581C87;
}
.bank-section-sub {
  font-size: 7.5pt;
  font-style: italic;
  color: #64748B;
}

/* Bank Transactions Table */
.bank-trans-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 7.8pt;
  margin-bottom: 10px;
}
.bank-trans-table th {
  border-bottom: 1.5px solid #7B19D4;
  padding: 3px 4px;
  text-align: left;
  font-style: italic;
  font-weight: 700;
  color: #581C87;
}
.bank-trans-table th.right, .bank-trans-table td.right {
  text-align: right;
}
.bank-trans-table td {
  padding: 3.5px 4px;
  border-bottom: 1px solid #E2E8F0;
  vertical-align: middle;
  color: #1E293B;
}
.bank-trans-table tr:nth-child(even) td {
  background-color: #F8FAFC;
}
.bank-trans-table tfoot td {
  border-top: 1.5px solid #7B19D4;
  border-bottom: 2px solid #581C87;
  font-weight: 800;
  background-color: #F5F3FF;
  color: #4C1D95;
  padding: 4px;
}

/* Callout */
.bank-callout {
  border-top: 1px solid #7B19D4;
  border-bottom: 1px solid #7B19D4;
  background-color: #FAF5FF;
  color: #3B0764;
  padding: 5px 8px;
  font-size: 7.5pt;
  margin-top: 8px;
  margin-bottom: 10px;
  line-height: 1.35;
  border-radius: 2px;
}

/* Detail Card Ledger */
.bank-ledger-card {
  border: 1px solid #DDD6FE;
  border-top: none;
  margin-bottom: 10px;
  background-color: #FFF;
  page-break-inside: avoid;
  break-inside: avoid;
  border-radius: 4px;
  overflow: hidden;
}
.bank-ledger-header {
  background: linear-gradient(135deg, #7B19D4 0%, #581C87 100%);
  color: #FFF;
  padding: 4px 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 8.5pt;
  font-weight: 800;
}
.bank-ledger-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-bottom: 1px solid #E2E8F0;
  font-size: 7.5pt;
}
.bank-ledger-cell {
  padding: 3px 6px;
  border-right: 1px solid #E2E8F0;
}
.bank-ledger-cell:last-child { border-right: none; }
.bank-ledger-lbl { font-style: italic; color: #64748B; font-size: 7pt; }
.bank-ledger-val { font-weight: 700; color: #0F172A; }
.bank-subtable-title {
  font-size: 7.5pt;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #581C87;
  margin-top: 4px;
  margin-bottom: 2px;
  padding: 0 6px;
}

/* Maturity Projection Banner */
.bank-maturity-banner {
  background: linear-gradient(135deg, #FAF5FF 0%, #F3E8FF 100%);
  border: 1.5px solid #C084FC;
  border-radius: 6px;
  padding: 6px 10px;
  margin: 4px 6px 8px 6px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  align-items: center;
}
.bank-maturity-kpi-lbl {
  font-size: 6.8pt;
  color: #6B21A8;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.bank-maturity-kpi-val {
  font-size: 8.8pt;
  font-weight: 700;
  color: #0F172A;
}
.bank-maturity-payout-box {
  background: #FFFFFF;
  border: 1.5px solid #7B19D4;
  border-radius: 5px;
  padding: 4px 8px;
  text-align: right;
}
.bank-maturity-payout-lbl {
  font-size: 6.5pt;
  color: #581C87;
  font-weight: 800;
  text-transform: uppercase;
  margin-bottom: 1px;
}
.bank-maturity-payout-val {
  font-size: 10.5pt;
  font-weight: 900;
  color: #581C87;
  line-height: 1.1;
}

/* Bank Footer */
.bank-footer-container {
  margin-top: auto;
  padding-top: 8px;
}
.bank-footer-bar {
  border-top: 2px solid #7B19D4;
  padding-top: 3px;
  font-size: 7.5pt;
  display: flex;
  justify-content: space-between;
  color: #581C87;
  font-weight: 600;
}

@media print {
  @page { size: A4 portrait; margin: 10mm 12mm 12mm 12mm; }
  html, body { background-color: #FFF !important; font-size: 8.5pt !important; }
  .report-page { box-shadow: none !important; padding: 0 !important; margin: 0 !important; min-height: auto !important; }
  .bank-ledger-header, .bank-balance-table, .bank-trans-table th, .bank-maturity-banner { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/* ─────────────────────────── the detail cards ──────────────────────────── */

function portfolioCardBank(p: StatementPortfolio): string {
  const principal = principalOf(p);
  const compounded = compoundedOf(p);
  const isCompound = typeOf(p) === 'Compound' || (p.roi_mode ?? '').includes('compound');
  const durationMonths = p.duration_months && p.duration_months > 0 ? p.duration_months : 12;
  const ratePct = n(p.rate);

  let projectedMaturityValue = principal;
  for (let m = 0; m < durationMonths; m++) {
    projectedMaturityValue += Math.round(projectedMaturityValue * (ratePct / 100));
  }
  const projectedReturns = Math.max(0, projectedMaturityValue - principal);
  const growthMultiple = principal > 0 ? (projectedMaturityValue / principal).toFixed(1) : '1';

  const maturitySection = isCompound ? `
    <div class="bank-subtable-title" style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 6px;">
      <span>Contract Maturity Projection (${durationMonths} Months)</span>
      <span style="font-size: 7pt; font-weight: 600; text-transform: none; color: #7B19D4;">
        Maturity: ${day(p.maturity_date)} (${growthMultiple}x initial capital)
      </span>
    </div>
    <div class="bank-maturity-banner">
      <div>
        <div class="bank-maturity-kpi-lbl">Initial Principal</div>
        <div class="bank-maturity-kpi-val num">${ugx(principal)}</div>
      </div>
      <div>
        <div class="bank-maturity-kpi-lbl">Monthly Return Rate</div>
        <div class="bank-maturity-kpi-val font-mono">${ratePct}% / mo</div>
      </div>
      <div>
        <div class="bank-maturity-kpi-lbl">Projected Returns (${durationMonths} Mo)</div>
        <div class="bank-maturity-kpi-val num" style="color: #7B19D4;">+${ugx(projectedReturns)}</div>
      </div>
      <div class="bank-maturity-payout-box">
        <div class="bank-maturity-payout-lbl">Total Payout at Maturity</div>
        <div class="bank-maturity-payout-val num">${ugx(projectedMaturityValue)}</div>
      </div>
    </div>` : '';

  const payoutsRows = (p.payouts ?? []).map(
    (w) => `<tr>${td(day(w.date), 'nowrap')}${td(w.reference ?? DASH)}${td(num(w.amount), 'right num')}</tr>`,
  ).join('');

  const compoundsRows = (p.compounds ?? []).map(
    (c) => `<tr>${td(day(c.date), 'nowrap')}${td(c.reference ?? DASH)}${td(num(c.amount), 'right num')}</tr>`,
  ).join('');

  const changesEvents = [
    ...(p.renewals ?? []).map((r) => ({ date: r.date, what: 'Term Renewed' })),
    ...(p.changes ?? []),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const changesRows = changesEvents.map(
    (c) => `<tr>${td(day(c.date), 'nowrap')}${td(c.what)}</tr>`,
  ).join('');

  return `<div class="bank-ledger-card">
  <div class="bank-ledger-header">
    <span>Portfolio: ${esc(p.code ?? p.id.slice(0, 8))} (${esc(statusOf(p.status))})</span>
    <span style="font-size: 8pt; font-weight: normal;">${esc(`${n(p.rate)}% · ${modeWords(p)}`)}</span>
  </div>
  <div class="bank-ledger-grid">
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Start Date</div><div class="bank-ledger-val">${day(p.start_date)}</div></div>
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Maturity Date</div><div class="bank-ledger-val">${day(p.maturity_date)}</div></div>
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Term</div><div class="bank-ledger-val">${p.duration_months == null ? DASH : `${p.duration_months} Months`}</div></div>
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Type</div><div class="bank-ledger-val">${typeOf(p)}</div></div>
  </div>
  <div class="bank-ledger-grid" style="background-color: #F8FAFC;">
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Principal</div><div class="bank-ledger-val num">${ugx(principal)}</div></div>
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Return Added</div><div class="bank-ledger-val num">${ugx(compounded)}</div></div>
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Monthly Return</div><div class="bank-ledger-val num">${ugx(monthlyOf(p))}</div></div>
    <div class="bank-ledger-cell"><div class="bank-ledger-lbl">Current Worth</div><div class="bank-ledger-val num" style="color:#1E1B4B; font-weight:800;">${ugx(p.current_value)}</div></div>
  </div>
  <div style="padding: 4px 6px;">
    ${maturitySection}
    ${payoutsRows ? `
      <div class="bank-subtable-title">Payouts (Money Out)</div>
      <table class="bank-trans-table" style="margin-bottom: 4px;">
        <thead><tr><th>Date</th><th>Reference</th><th class="right">Amount (UGX)</th></tr></thead>
        <tbody>${payoutsRows}</tbody>
      </table>` : ''}
    ${compoundsRows ? `
      <div class="bank-subtable-title">Compounded Returns</div>
      <table class="bank-trans-table" style="margin-bottom: 4px;">
        <thead><tr><th>Date</th><th>Reference</th><th class="right">Amount (UGX)</th></tr></thead>
        <tbody>${compoundsRows}</tbody>
      </table>` : ''}
    ${changesRows ? `
      <div class="bank-subtable-title">Renewals & Changes</div>
      <table class="bank-trans-table" style="margin-bottom: 4px;">
        <thead><tr><th>Date</th><th>Description</th></tr></thead>
        <tbody>${changesRows}</tbody>
      </table>` : ''}
  </div>
</div>`;
}

/* ───────────────────────────── Pagination ────────────────────────────── */

const CARD_BASE_PX = 320;
const CARD_ROW_PX = 18;
const SHEET_PX = 990;
const SECTION_TITLE_PX = 28;
const PAGE1_CHROME_PX = 460;
const SUMMARY_ROW_PX = 19;

function paginate(ps: StatementPortfolio[]): StatementPortfolio[][] {
  const out: StatementPortfolio[][] = [];
  let current: StatementPortfolio[] = [];
  let used = 0;
  for (const p of ps) {
    const isCompound = typeOf(p) === 'Compound' || (p.roi_mode ?? '').includes('compound');
    const rows = (p.payouts?.length ?? 0) + (p.compounds?.length ?? 0)
      + (p.renewals?.length ?? 0) + (p.changes?.length ?? 0) + 1;
    const cost = CARD_BASE_PX + (isCompound ? 55 : 0) + rows * CARD_ROW_PX;
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

export function buildPartnerStatementHtml(d: StatementData): string {
  const ps = d.portfolios;
  const totalPrincipal = ps.reduce((s, p) => s + principalOf(p), 0);
  const totalCompounded = ps.reduce((s, p) => s + compoundedOf(p), 0);
  const totalValue = ps.reduce((s, p) => s + n(p.current_value), 0);
  const totalMonthly = ps.reduce((s, p) => s + monthlyOf(p), 0);
  const active = ps.filter((p) => p.status === 'active').length;

  const stamp = String(d.generated_at).slice(0, 10);
  const who = d.partner?.name ?? 'Supporter';
  const ref = `W-SPS-${stamp.replace(/-/g, '')}`;

  // Top Bank Header
  const header = `<div class="bank-header-row">
  <div class="bank-logo-wrap">
    <img src="${welileLogoUrl}" alt="Welile" class="bank-logo-img" />
    <div class="bank-name-block">
      <span class="bank-main-title">WELILE</span>
      <span class="bank-sub-title">TECHNOLOGIES</span>
    </div>
  </div>
  <div class="bank-header-right">
    <div class="bank-statement-red-title">Your Statement</div>
    <div class="bank-contact-details">
      <div><strong>Contact Tel:</strong> +256 700 000 000 / +256 775 077 741</div>
      <div><strong>Support:</strong> support@welileapp.com</div>
      <div><strong>Portal:</strong> www.welileapp.com</div>
    </div>
  </div>
</div>`;

  // Dual Summary Grid
  const dualSummary = `<div class="bank-dual-grid">
  <div class="bank-account-box">
    <div class="bank-account-box-title">Supporter Portfolio Statement</div>
    <div class="bank-account-row">
      <span class="bank-account-lbl">Account Name</span>
      <span class="bank-account-val">${esc(who.toUpperCase())}</span>
    </div>
    <div class="bank-account-row">
      <span class="bank-account-lbl">Account number</span>
      <span class="bank-account-val font-mono">${esc(d.partner?.phone ?? d.partner?.mobile_money ?? '00990275')}</span>
    </div>
    <div class="bank-account-row">
      <span class="bank-account-lbl">Statement Ref</span>
      <span class="bank-account-val font-mono">${esc(ref)}</span>
    </div>
    <div class="bank-account-row">
      <span class="bank-account-lbl">Sort Code</span>
      <span class="bank-account-val font-mono">40-06-15</span>
    </div>
  </div>
  <div class="bank-summary-right">
    <table class="bank-balance-table">
      <tbody>
        <tr>
          <td>Opening Balance / Principal</td>
          <td class="b-val num">${esc(ugx(totalPrincipal))}</td>
        </tr>
        <tr>
          <td>Payments In (Returns Added)</td>
          <td class="b-val num">${esc(ugx(totalCompounded))}</td>
        </tr>
        <tr>
          <td>Payments Out (Payouts)</td>
          <td class="b-val num">${esc(ugx(d.payouts_total.amount))}</td>
        </tr>
        <tr class="b-closing">
          <td><strong>Closing Balance / Valuation</strong></td>
          <td class="b-val num"><strong>${esc(ugx(totalValue))}</strong></td>
        </tr>
        <tr>
          <td>Account Type</td>
          <td class="b-val" style="font-size: 7pt;">SUPPORTER CAPITAL / UGX</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>`;

  // Address & Meta Row
  const metaRow = `<div class="bank-meta-row">
  <div class="bank-meta-left">
    <div class="bank-meta-date">${day(stamp)}</div>
    <div class="bank-recipient-block">
      <div>${esc(who.toUpperCase())}</div>
      <div>${esc(d.partner?.phone ? `MOBILE: ${d.partner.phone}` : '')}</div>
      <div>UGANDA</div>
    </div>
  </div>
  <div class="bank-meta-right">
    <div><strong>International Supporter Ref</strong></div>
    <div class="font-mono">IDLUG225278/${stamp.replace(/-/g, '')}</div>
    <div class="font-mono" style="margin-top: 3px;"><strong>WELILEUGX2026</strong></div>
  </div>
</div>`;

  // Transactions Summary Head
  const SUMMARY_HEAD = `<tr>
    <th style="width:25px">#</th>
    <th>Portfolio Ref</th>
    <th>Status</th>
    <th class="right">Rate</th>
    <th class="right">Principal (UGX)</th>
    <th class="right">Return / Month</th>
    <th class="right">Closing Balance (UGX)</th>
    <th>Start</th>
    <th>Matures</th>
    <th class="right">Days Left</th>
    <th>Type</th>
  </tr>`;

  const summaryRows = ps.map((p, i) => {
    const principal = principalOf(p);
    return `<tr>
      <td>${String(i + 1)}</td>
      <td class="cell-strong font-mono">${esc(p.code ?? p.id.slice(0, 8))}</td>
      <td><strong>${esc(statusOf(p.status))}</strong></td>
      <td class="right font-mono">${n(p.rate)}%</td>
      <td class="right num">${num(principal)}</td>
      <td class="right num">${num(monthlyOf(p))}</td>
      <td class="right num cell-strong">${num(p.current_value)}</td>
      <td class="nowrap">${day(p.start_date)}</td>
      <td class="nowrap">${day(p.maturity_date)}</td>
      <td class="right font-mono">${p.days_left == null ? DASH : num(p.days_left)}</td>
      <td class="nowrap">${typeOf(p)}</td>
    </tr>`;
  });

  const summaryFoot = `<tr class="bank-trans-foot">
    <td colspan="4"><strong>CLOSING TOTALS</strong></td>
    <td class="right num"><strong>${num(totalPrincipal)}</strong></td>
    <td class="right num"><strong>${num(totalMonthly)}</strong></td>
    <td class="right num"><strong>${num(totalValue)}</strong></td>
    <td colspan="4"></td>
  </tr>`;

  const caveat = `<div class="bank-callout">
    <strong>Important Payout & Activity Information:</strong> ${num(d.payouts_total.count)} payout${d.payouts_total.count === 1 ? '' : 's'} totalling ${ugx(d.payouts_total.amount)} are recorded on this account. A payout appears against an individual portfolio when linked to that disbursement. Closing Balance represents active portfolio capital.
  </div>`;

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

  const renderFooter = (pageIndex: number) => `
  <footer class="bank-footer-container">
    <div class="bank-footer-bar">
      <span><strong>Correspondence:</strong> Welile Technologies Limited • Kampala, Uganda</span>
      <span><strong>Sort Code:</strong> 40-06-15</span>
      <span><strong>Statement page ${pageIndex} of ${total}</strong></span>
    </div>
  </footer>`;

  const summaryPages = summaryChunks.map((rows, i) => {
    const last = i === summaryChunks.length - 1;
    const body = `<table class="bank-trans-table">
      <thead>${SUMMARY_HEAD}</thead>
      <tbody>${rows.join('')}</tbody>
      ${last ? `<tfoot>${summaryFoot}</tfoot>` : ''}
    </table>`;

    const sectionHeading = `<div class="bank-section-bar">
      <h2>Portfolios & Transactions</h2>
      <span class="bank-section-sub">${ps.length} Portfolios · ${active} Active</span>
    </div>`;

    return `<article class="report-page">
      <div class="page-content">
        ${i === 0 ? `${header}${dualSummary}${metaRow}` : ''}
        ${sectionHeading}
        ${body}
        ${last ? caveat : ''}
      </div>
      ${renderFooter(i + 1)}
    </article>`;
  });

  const detailPages = detailChunks.map((chunk, i) => {
    const sectionHeading = `<div class="bank-section-bar">
      <h2>Portfolio Activity Breakdown</h2>
      <span class="bank-section-sub">Detailed Ledger Entries</span>
    </div>`;

    return `<article class="report-page">
      <div class="page-content">
        <div class="bank-header-row" style="margin-bottom: 8px;">
          <div class="bank-logo-wrap">
            <img src="${welileLogoUrl}" alt="Welile" class="bank-logo-img" style="height:28px;" />
            <span class="bank-main-title" style="font-size:11pt;">WELILE TECHNOLOGIES</span>
          </div>
          <div class="bank-header-right">
            <span class="bank-statement-red-title" style="font-size:11pt;">Your Statement (Continued)</span>
          </div>
        </div>
        ${sectionHeading}
        ${chunk.map(portfolioCardBank).join('')}
      </div>
      ${renderFooter(summaryChunks.length + i + 1)}
    </article>`;
  });

  return shell({
    title: `Welile — Supporter Portfolio Statement — ${who}`,
    pages: [...summaryPages, ...detailPages],
    noCharts: true,
    extraCss: BANK_STATEMENT_CSS,
  });
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
