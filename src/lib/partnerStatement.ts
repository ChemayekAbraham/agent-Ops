/**
 * The partner portfolio statement.
 *
 * A record of what actually happened: every portfolio, what was put in, the
 * Returns added to it, money taken out, renewals and office corrections. That
 * is a different document from the projection PDF, which shows what a
 * portfolio is *expected* to earn — one looks back, the other forward, and a
 * partner usually wants to be asked which.
 *
 * It is written as a self-contained HTML file rather than drawn with jsPDF.
 * The statement is a multi-page A4 document with a table per category per
 * portfolio; laying that out by hand in PDF primitives would be brittle, and
 * the browser's own print dialogue produces a better PDF from this markup than
 * we would. Nothing is fetched at open time — no script, no web fonts, no
 * network — so it reads the same from an inbox, a phone or a print queue.
 *
 * Read-only. `my_portfolio_statement` proves ownership from `auth.uid()`, so
 * the browser cannot ask for anyone else's portfolios.
 */
import { supabase } from '@/integrations/supabase/client';

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

/* ─────────────────────────────── rendering ─────────────────────────────── */

const DASH = '&mdash;';
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const ugx = (v: unknown) => `UGX ${Math.round(n(v)).toLocaleString('en-US')}`;
const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : DASH);

const STATUS: Record<string, [string, string]> = {
  active: ['Active', 'ok'],
  cancelled: ['Closed', 'muted'],
  awaiting_partner_details: ['Awaiting your details', 'warn'],
  locked: ['Locked', 'warn'],
  pending_ops_approval: ['Being set up', 'warn'],
};

function statusOf(s: string): [string, string] {
  return STATUS[s] ?? [s.replace(/_/g, ' '), 'muted'];
}

/** Compound, Payout or Self support, in the partner's own words. */
function typeOf(p: StatementPortfolio): string {
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

/** Returns already folded into the balance, so principal is the balance less them. */
const compoundedOf = (p: StatementPortfolio) =>
  (p.compounds ?? []).reduce((s, c) => s + n(c.amount), 0);
const principalOf = (p: StatementPortfolio) =>
  Math.max(0, n(p.current_value) - compoundedOf(p));

function rows(body: string, empty: string): string {
  return body ? body : `<tr><td colspan="9" class="none">${empty}</td></tr>`;
}

function portfolioCard(p: StatementPortfolio): string {
  const [label, tone] = statusOf(p.status);
  const principal = principalOf(p);
  const compounded = compoundedOf(p);
  const monthly = Math.round(principal * n(p.rate) / 100);

  const payouts = (p.payouts ?? []).map((w) =>
    `<tr><td>${day(w.date)}</td><td class="mono">${esc(w.reference ?? '')}</td>` +
    `<td class="r">${ugx(w.amount)}</td></tr>`).join('');

  const compounds = (p.compounds ?? []).map((c) =>
    `<tr><td>${day(c.date)}</td><td class="mono">${esc(c.reference ?? '')}</td>` +
    `<td class="r">${ugx(c.amount)}</td></tr>`).join('');

  const changes = [
    ...(p.renewals ?? []).map((r) => ({ date: r.date, what: 'Renewed for another term' })),
    ...(p.changes ?? []),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)))
   .map((c) => `<tr><td>${day(c.date)}</td><td>${esc(c.what)}</td></tr>`).join('');

  return `
<section class="pf">
  <div class="pfh">
    <h3>${esc(p.code ?? p.id.slice(0, 8))}</h3>
    <span class="badge ${tone}">${esc(label)}</span>
    <span class="rate">${n(p.rate)}% &middot; ${esc(modeWords(p))}</span>
    <span class="grow">Principal <b>${ugx(principal)}</b> &nbsp;&bull;&nbsp; Worth now <b>${ugx(p.current_value)}</b></span>
  </div>

  <h4>Portfolio details</h4>
  <table class="t">
    <tr><td>Contribution date</td><td class="r">${day(p.start_date)}</td></tr>
    <tr><td>Portfolio name</td><td class="r"><b>${esc(p.name || p.code || DASH)}</b></td></tr>
    <tr><td>Portfolio ID</td><td class="r mono">${esc(p.id.slice(0, 8))}</td></tr>
    <tr><td>Return rate</td><td class="r">${n(p.rate)}%</td></tr>
    <tr><td>Maturity date</td><td class="r">${day(p.maturity_date)}</td></tr>
    <tr><td>Days left</td><td class="r">${p.days_left ?? DASH}</td></tr>
    <tr><td>Term</td><td class="r">${p.duration_months ?? DASH} months</td></tr>
    <tr><td>Principal</td><td class="r"><b>${ugx(principal)}</b></td></tr>
    <tr><td>Return each month</td><td class="r">${ugx(monthly)}</td></tr>
  </table>

  <h4>Payouts (money taken out)</h4>
  <table class="t"><thead><tr><th>Date</th><th>Reference</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows(payouts, 'No payout is linked to this portfolio.')}</tbody></table>

  <h4>Top-ups</h4>
  <table class="t"><thead><tr><th>Date</th><th>What happened</th><th class="r">Amount</th></tr></thead>
    <tbody><tr><td>${day(p.start_date)}</td><td>Portfolio opened</td><td class="r">${ugx(principal)}</td></tr></tbody></table>

  <h4>Compounds (Return added)</h4>
  <table class="t"><thead><tr><th>Date</th><th>Reference</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows(compounds, 'No Return has been added to this portfolio yet.')}</tbody>
    ${compounds ? `<tfoot><tr><td>Total</td><td></td><td class="r">${ugx(compounded)}</td></tr></tfoot>` : ''}
  </table>

  <h4>Renewals &amp; changes</h4>
  <table class="t"><thead><tr><th>Date</th><th>What happened</th></tr></thead>
    <tbody>${rows(changes, 'No renewal or change recorded.')}</tbody></table>
</section>`;
}

/** The whole statement as one self-contained HTML document. */
export function renderStatementHtml(d: StatementData): string {
  const ps = d.portfolios;
  const totalPrincipal = ps.reduce((s, p) => s + principalOf(p), 0);
  const totalCompounded = ps.reduce((s, p) => s + compoundedOf(p), 0);
  const totalValue = ps.reduce((s, p) => s + n(p.current_value), 0);
  const totalMonthly = ps.reduce((s, p) => s + Math.round(principalOf(p) * n(p.rate) / 100), 0);
  const active = ps.filter((p) => p.status === 'active').length;
  const dateStr = String(d.generated_at).slice(0, 10);

  const summary = ps.map((p, i) => {
    const [label, tone] = statusOf(p.status);
    const principal = principalOf(p);
    return `<tr><td>${i + 1}</td><td class="mono">${esc(p.code ?? '')}</td>` +
      `<td><span class="badge ${tone}">${esc(label)}</span></td>` +
      `<td class="r">${n(p.rate)}%</td><td class="r">${ugx(principal)}</td>` +
      `<td class="r">${ugx(Math.round(principal * n(p.rate) / 100))}</td>` +
      `<td class="r b">${ugx(p.current_value)}</td>` +
      `<td>${day(p.start_date)}</td><td>${day(p.maturity_date)}</td>` +
      `<td class="r">${p.days_left ?? DASH}</td><td>${typeOf(p)}</td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portfolio statement — ${esc(d.partner?.name ?? 'Partner')}</title>
<style>
:root{--ink:#0F172A;--mut:#64748B;--line:#E2E8F0;--bg:#E2E8F0;--pri:#7B19D4;
--pri-d:#581C87;--ok:#15803D;--okbg:#F0FDF4;--warn:#B45309;--warnbg:#FFFBEB}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:11px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.doc{width:100%;max-width:210mm;margin:16px auto;padding:0 8px}
.page{background:#fff;padding:14mm 12mm;margin:0 auto 16px;box-shadow:0 4px 15px rgba(0,0,0,.08);
page-break-after:always;break-after:page}
.page:last-child{page-break-after:auto;break-after:auto}
.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;
border-bottom:2px solid var(--ink);padding-bottom:10px;margin-bottom:12px;flex-wrap:wrap}
.co{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--pri)}
h1{font-size:17px;font-weight:900;letter-spacing:-.4px;margin-top:2px}
.sub{font-size:9px;color:var(--mut)}
.meta td{font-size:9px;padding:1.5px 0 1.5px 8px;text-align:right}
.meta .l{color:var(--mut);font-weight:600;text-transform:uppercase}
.hero{background:linear-gradient(135deg,#FAF5FF,#F5F3FF);border:1px solid #E9D5FF;border-radius:6px;
padding:12px 16px;margin-bottom:12px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.hero h2{font-size:16px;font-weight:800;color:var(--pri-d)}
.hero .c{font-size:9.5px;color:#334155;margin-top:3px}
.pill{background:#fff;border:1px solid var(--line);padding:8px 12px;border-radius:5px;min-width:130px;text-align:right}
.pill .l{font-size:7.5px;font-weight:800;text-transform:uppercase;color:var(--mut);letter-spacing:.4px}
.pill .v{font-size:13.5px;font-weight:800;color:var(--pri)}
.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.kpi div{background:#F8FAFC;border:1px solid var(--line);padding:7px 9px;border-radius:4px;text-align:center}
.kpi .l{font-size:7.5px;font-weight:800;text-transform:uppercase;color:var(--mut)}
.kpi .v{font-size:12px;font-weight:800}
h2.sec{font-size:11px;font-weight:800;border-bottom:1px solid #CBD5E1;padding-bottom:3px;margin:12px 0 6px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:8.5px}
th{background:#F8FAFC;color:var(--mut);font-weight:700;text-transform:uppercase;font-size:7.5px;
letter-spacing:.4px;padding:4px 6px;border-top:1px solid #CBD5E1;border-bottom:1.5px solid #CBD5E1;text-align:left}
td{padding:4px 6px;border-bottom:1px solid var(--line)}
tbody tr:nth-child(even) td{background:#FAFAFA}
tfoot td{font-weight:800;background:#F8FAFC;border-top:1.5px solid var(--ink)}
.r{text-align:right}.b{font-weight:800;color:var(--pri)}
.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:7.5px}
.none{color:var(--mut);font-style:italic}
.badge{display:inline-block;padding:1.5px 6px;border-radius:3px;font-size:7.5px;font-weight:800;
text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.badge.ok{background:var(--okbg);color:var(--ok);border:1px solid #BBF7D0}
.badge.warn{background:var(--warnbg);color:var(--warn);border:1px solid #FDE68A}
.badge.muted{background:#F1F5F9;color:#475569;border:1px solid #CBD5E1}
.pf{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:10px;
break-inside:avoid;page-break-inside:avoid}
.pfh{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.pfh h3{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;font-weight:800;color:var(--pri-d)}
.rate,.grow{font-size:8.5px;color:var(--mut)}
h4{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);margin:8px 0 3px}
.note{border:1px solid var(--line);border-left:3px solid var(--warn);background:#FAF5FF;
padding:8px 12px;font-size:8.5px;margin:10px 0}
.ft{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--line);
padding-top:8px;margin-top:10px;font-size:8.5px;color:var(--mut);flex-wrap:wrap}
@media(max-width:820px){
  body{font-size:12px}
  .doc{margin:8px auto;padding:0 6px}
  .page{padding:14px 12px;border-radius:8px}
  .hd,.hero{flex-direction:column}
  .meta td{text-align:left;padding-left:0}
  .kpi{grid-template-columns:repeat(2,1fr)}
  .scroll table{min-width:700px}
}
@media print{
  @page{size:A4 portrait;margin:10mm}
  body{background:#fff;font-size:8.5pt}
  .doc{margin:0;padding:0;max-width:none}
  .page{box-shadow:none;padding:0;margin:0}
  .scroll{overflow:visible}.scroll table{min-width:0}
}
</style></head><body><div class="doc">

<div class="page">
  <div class="hd">
    <div>
      <div class="co">WELILE TECHNOLOGIES LIMITED</div>
      <h1>Partner Portfolio Statement</h1>
      <div class="sub">Everything you have put in, what it has earned, and what it is worth today</div>
    </div>
    <table class="meta">
      <tr><td class="l">Partner:</td><td><b>${esc(d.partner?.name ?? DASH)}</b></td></tr>
      <tr><td class="l">Statement date:</td><td><b>${dateStr}</b></td></tr>
      <tr><td class="l">Portfolios:</td><td><b>${ps.length}</b></td></tr>
    </table>
  </div>

  <div class="hero">
    <div>
      <h2>${esc(d.partner?.name ?? 'Partner')}</h2>
      <div class="c">Mobile money: <b>${esc(d.partner?.mobile_money ?? DASH)}</b>
        &nbsp;&bull;&nbsp; Phone: <b>${esc(d.partner?.phone ?? DASH)}</b></div>
      <div class="c">${ps.length} portfolios &bull; ${active} still running</div>
    </div>
    <div class="pill"><div class="l">TOTAL CAPITAL</div><div class="v">${ugx(totalValue)}</div></div>
    <div class="pill"><div class="l">TOTAL PAYOUTS</div><div class="v">${ugx(d.payouts_total.amount)}</div></div>
  </div>

  <div class="kpi">
    <div><div class="l">Money you put in</div><div class="v">${ugx(totalPrincipal)}</div></div>
    <div><div class="l">Return added</div><div class="v">${ugx(totalCompounded)}</div></div>
    <div><div class="l">Total capital</div><div class="v">${ugx(totalValue)}</div></div>
    <div><div class="l">Return each month</div><div class="v">${ugx(totalMonthly)}</div></div>
  </div>

  <h2 class="sec">All your portfolios (${ps.length})</h2>
  <div class="scroll">
  <table>
    <thead><tr><th>#</th><th>Portfolio ID</th><th>Status</th><th class="r">Rate</th>
      <th class="r">Principal</th><th class="r">Return</th><th class="r">Current value</th>
      <th>Start date</th><th>Matures</th><th class="r">Days left</th><th>Type</th></tr></thead>
    <tbody>${summary || '<tr><td colspan="11" class="none">No portfolios yet.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="4" class="r">TOTALS</td><td class="r">${ugx(totalPrincipal)}</td>
      <td class="r">${ugx(totalMonthly)}</td><td class="r b">${ugx(totalValue)}</td>
      <td colspan="4"></td></tr></tfoot>
  </table>
  </div>

  <div class="note">
    <b>About money taken out.</b>
    ${d.payouts_total.count} payouts totalling <b>${ugx(d.payouts_total.amount)}</b> are recorded on
    this account. A payout only appears against a portfolio below when it records which portfolio it
    came from, so &ldquo;worth now&rdquo; is the portfolio balance rather than the balance after
    money was taken out.
  </div>

  <div class="ft"><span>WELILE TECHNOLOGIES LIMITED &bull; PARTNER PORTFOLIO STATEMENT</span>
    <span>${dateStr} &bull; PAGE 1</span></div>
</div>

<div class="page">
  <div class="hd"><div><div class="co">WELILE TECHNOLOGIES LIMITED</div>
    <h1 style="font-size:14px">Each Portfolio in Detail</h1></div>
    <table class="meta"><tr><td class="l">Partner:</td><td><b>${esc(d.partner?.name ?? DASH)}</b></td></tr>
      <tr><td class="l">Statement date:</td><td><b>${dateStr}</b></td></tr></table></div>
  ${ps.map(portfolioCard).join('')}
  <div class="ft"><span>WELILE TECHNOLOGIES LIMITED &bull; PARTNER PORTFOLIO STATEMENT</span>
    <span>${dateStr} &bull; PAGE 2</span></div>
</div>

</div></body></html>`;
}

/**
 * Build and save the statement.
 * @param portfolioId omit for every portfolio the partner holds.
 */
export async function downloadPartnerStatement(portfolioId?: string): Promise<void> {
  const data = await fetchPartnerStatement(portfolioId);
  if (data.portfolios.length === 0) {
    throw new Error('There are no portfolios to put in a statement yet.');
  }
  const html = renderStatementHtml(data);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const who = (data.partner?.name ?? 'partner').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const scope = portfolioId
    ? (data.portfolios[0].code ?? portfolioId.slice(0, 8))
    : 'all-portfolios';
  a.href = url;
  a.download = `welile-statement-${who}-${scope}-${String(data.generated_at).slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick so the download has taken the reference.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
