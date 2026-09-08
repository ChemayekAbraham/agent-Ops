/**
 * Printable (PDF-ready) HTML for the Agent Operations → Reports → Overview
 * reports. The markup and design tokens follow the supplied Welile report
 * templates (Inter/JetBrains Mono, purple #7B19D4 header rail, KPI strip,
 * tabular-number tables, A4 print rules).
 *
 * Everything here is presentation only — figures arrive already aggregated
 * from the report RPCs, so nothing is recomputed or invented client-side.
 */
import type {
  AdvancesReport,
  AgentReport,
  ProductsReport,
  RentCollectionsReport,
  TeamCollectionsReport,
} from '@/hooks/useAgentOpsReports';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const ugx = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `UGX ${Math.round(Number(n)).toLocaleString('en-UG')}`;

const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : Math.round(Number(n)).toLocaleString('en-UG');

const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${Number(n).toFixed(1)}%`;

const day = (v: string | null | undefined): string => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const dayTime = (v: string | null | undefined): string => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(v);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

const CSS = `
:root{--primary:#7B19D4;--primary-dark:#581C87;--primary-light:#F3E8FF;--text-main:#0F172A;--text-body:#334155;--text-muted:#64748B;--bg-header:#F8FAFC;--bg-subtle:#F1F5F9;--border-color:#E2E8F0;--border-dark:#CBD5E1;--ok:#15803D;--ok-bg:#F0FDF4;--warn:#B45309;--warn-bg:#FFFBEB;--bad:#B91C1C;--bad-bg:#FEF2F2}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#E2E8F0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text-main);font-size:11px;line-height:1.45;-webkit-font-smoothing:antialiased}
.num,.currency,.pct,.date,td.right,th.right{font-variant-numeric:tabular-nums}
.page{background:#fff;width:210mm;min-height:297mm;margin:12px auto;padding:14mm 12mm;box-shadow:0 6px 24px rgba(15,23,42,.16)}
.rail{background:var(--primary);color:#fff;border-radius:8px;padding:14px 16px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.rail h1{font-size:16px;font-weight:800;letter-spacing:-.2px}
.rail p{font-size:10px;opacity:.9;margin-top:3px}
.brand{font-size:13px;font-weight:900;letter-spacing:1px}
.meta{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
.meta span{background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:999px;padding:3px 9px;font-size:9.5px;color:var(--text-body);font-weight:600}
.subject{margin-top:14px;border:1px solid var(--border-color);border-left:3px solid var(--primary);border-radius:6px;padding:10px 12px;background:var(--bg-header)}
.subject h2{font-size:13px;font-weight:800}
.subject p{font-size:10px;color:var(--text-muted);margin-top:2px}
.kpis{margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px}
.kpi{border:1px solid var(--border-color);border-radius:6px;padding:8px 10px;background:#fff}
.kpi-label{font-size:8.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-muted)}
.kpi-value{margin-top:3px;font-size:13px;font-weight:800;color:var(--text-main)}
.section-title{margin:16px 0 8px;display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:var(--primary-dark);border-bottom:2px solid var(--primary-light);padding-bottom:5px}
table{width:100%;border-collapse:collapse;font-size:9.5px}
thead th{background:var(--bg-header);border-top:1px solid var(--border-dark);border-bottom:1px solid var(--border-dark);padding:6px 6px;text-align:left;font-weight:700;color:var(--text-body);white-space:nowrap}
tbody td{border-bottom:1px solid var(--border-color);padding:5px 6px;vertical-align:top;color:var(--text-body)}
tbody tr:nth-child(even) td{background:#FCFCFD}
th.right,td.right{text-align:right}
tfoot td{border-top:2px solid var(--border-dark);padding:6px;font-weight:800;background:var(--bg-subtle);color:var(--text-main)}
.tag{display:inline-block;border-radius:999px;padding:1px 7px;font-size:8.5px;font-weight:700;border:1px solid}
.tag.ok{color:var(--ok);background:var(--ok-bg);border-color:#BBF7D0}
.tag.warn{color:var(--warn);background:var(--warn-bg);border-color:#FDE68A}
.tag.bad{color:var(--bad);background:var(--bad-bg);border-color:#FECACA}
.foot{margin-top:14px;border-top:1px solid var(--border-color);padding-top:6px;font-size:8.5px;color:var(--text-muted);display:flex;justify-content:space-between;gap:12px}
.empty{padding:14px;text-align:center;color:var(--text-muted);font-size:10px;border:1px dashed var(--border-dark);border-radius:6px}
@page{size:A4;margin:10mm}
@media print{body{background:#fff}.page{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}thead{display:table-header-group}tr{page-break-inside:avoid}}
`;

function tone(rate: number | null | undefined): 'ok' | 'warn' | 'bad' {
  if (rate === null || rate === undefined) return 'warn';
  if (rate >= 75) return 'ok';
  if (rate >= 50) return 'warn';
  return 'bad';
}

function shell(opts: {
  title: string;
  subtitle: string;
  range: { from: string; to: string };
  subject?: { heading: string; sub: string };
  kpis: { label: string; value: string }[];
  body: string;
}): string {
  const generated = new Date().toLocaleString('en-GB');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welile — ${esc(opts.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="page">
<div class="rail"><div><h1>${esc(opts.title)}</h1><p>${esc(opts.subtitle)}</p></div><div style="text-align:right"><div class="brand">WELILE</div><p style="font-size:9px;opacity:.85">Agent Operations</p></div></div>
<div class="meta"><span>Window: ${esc(opts.range.from)} → ${esc(opts.range.to)}</span><span>Generated: ${esc(generated)}</span><span>Currency: UGX</span></div>
${opts.subject ? `<div class="subject"><h2>${esc(opts.subject.heading)}</h2><p>${esc(opts.subject.sub)}</p></div>` : ''}
<div class="kpis">${opts.kpis.map((k) => `<div class="kpi"><div class="kpi-label">${esc(k.label)}</div><div class="kpi-value">${k.value}</div></div>`).join('')}</div>
${opts.body}
<div class="foot"><span>Welile — Agent Operations report. Figures aggregated from collections, rent plans and daily eligibility snapshots.</span><span>Confidential</span></div>
</div></body></html>`;
}

/** Opens the report in a new tab and triggers the print/save-as-PDF dialog. */
export function printReportHtml(html: string, fileTitle: string): void {
  const w = window.open('', '_blank');
  if (!w) {
    // Popup blocked — fall back to a downloadable HTML file.
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileTitle}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.document.title = fileTitle;
  w.setTimeout(() => {
    w.focus();
    w.print();
  }, 500);
}

/* ------------------------------- builders -------------------------------- */

export function buildAgentReportHtml(r: AgentReport): string {
  const k = r.kpis;
  const rows = r.tenants
    .map(
      (t) => `<tr><td><strong>${esc(t.tenant_name || 'Unnamed tenant')}</strong><br><span style="color:#64748B">${esc(t.tenant_phone || '—')}</span></td>
<td class="right">${ugx(t.rent_amount)}</td><td class="right">${ugx(t.outstanding)}</td><td class="right">${ugx(t.repayment)}</td>
<td class="right">${ugx(t.collected)}</td><td class="right">${pct(t.percentage)}</td><td>${dayTime(t.last_collection_at)}</td></tr>`,
    )
    .join('');
  const sum = r.tenants.reduce(
    (a, t) => ({
      rent: a.rent + Number(t.rent_amount || 0),
      out: a.out + Number(t.outstanding || 0),
      rep: a.rep + Number(t.repayment || 0),
      col: a.col + Number(t.collected || 0),
    }),
    { rent: 0, out: 0, rep: 0, col: 0 },
  );
  const periods = r.periods
    .filter((p) => p.expected > 0 || p.collected > 0)
    .map(
      (p) => `<tr><td>${day(p.period)}</td><td class="right">${ugx(p.expected)}</td><td class="right">${ugx(p.collected)}</td><td class="right">${ugx(p.shortfall)}</td><td class="right">${pct(p.rate)}</td></tr>`,
    )
    .join('');

  const body = `
<div class="section-title">Rent repayment history (${esc(r.range.from)} → ${esc(r.range.to)})</div>
${periods ? `<table><thead><tr><th>Period</th><th class="right">Expected</th><th class="right">Collected</th><th class="right">Shortfall</th><th class="right">Rate</th></tr></thead><tbody>${periods}</tbody>
<tfoot><tr><td>Totals</td><td class="right">${ugx(k.expected_window)}</td><td class="right">${ugx(k.collected_window)}</td><td class="right">${ugx(Math.max(k.expected_window - k.collected_window, 0))}</td><td class="right">${pct(k.window_rate)}</td></tr></tfoot></table>`
    : '<div class="empty">No expected or collected activity recorded in this window.</div>'}
<div class="section-title">Tenant collections breakdown</div>
${rows ? `<table><thead><tr><th style="width:24%">Tenant Name &amp; Contact</th><th class="right">Rent Amount</th><th class="right">Outstanding</th><th class="right">Repayment</th><th class="right">Collected</th><th class="right">Percentage</th><th>Collection date</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td>Totals · ${r.tenants.length} tenants</td><td class="right">${ugx(sum.rent)}</td><td class="right">${ugx(sum.out)}</td><td class="right">${ugx(sum.rep)}</td><td class="right">${ugx(sum.col)}</td><td class="right">${pct(k.repayment_rate)}</td><td>—</td></tr></tfoot></table>`
    : '<div class="empty">No tenants on record for this agent.</div>'}`;

  return shell({
    title: 'Agent Performance & Tenant Collections Report',
    subtitle: 'Full rent repayment history with tenant-by-tenant collections',
    range: r.range,
    subject: {
      heading: r.agent.full_name || 'Unnamed agent',
      sub: `${r.agent.phone || 'No phone on record'} · ${k.assigned_tenants} tenants · ${k.active_repaying} active repaying`,
    },
    kpis: [
      { label: 'Assigned tenants', value: num(k.assigned_tenants) },
      { label: 'Active repaying', value: num(k.active_repaying) },
      { label: 'Rent value', value: ugx(k.rent_total) },
      { label: 'Total repayable', value: ugx(k.repayment_total) },
      { label: 'Collected to date', value: ugx(k.collected_to_date) },
      { label: 'Outstanding', value: ugx(k.outstanding) },
      { label: 'Repayment rate', value: pct(k.repayment_rate) },
      { label: 'Collected in window', value: ugx(k.collected_window) },
    ],
    body,
  });
}

export function buildRentCollectionsReportHtml(r: RentCollectionsReport): string {
  const k = r.kpis;
  const rows = r.rows
    .map(
      (a, i) => `<tr><td class="right">${i + 1}</td><td><strong>${esc(a.full_name || 'Unnamed agent')}</strong></td><td>${esc(a.phone || '—')}</td>
<td class="right">${num(a.repaying_tenants)}</td><td class="right">${ugx(a.expected)}</td><td class="right">${ugx(a.collected)}</td>
<td class="right">${pct(a.rate)}</td><td class="right">${num(a.paid_tenants)}</td><td><span class="tag ${tone(a.rate)}">${esc(a.status)}</span></td></tr>`,
    )
    .join('');
  const totals = r.rows.reduce(
    (acc, a) => ({
      tenants: acc.tenants + Number(a.repaying_tenants || 0),
      expected: acc.expected + Number(a.expected || 0),
      collected: acc.collected + Number(a.collected || 0),
      paid: acc.paid + Number(a.paid_tenants || 0),
    }),
    { tenants: 0, expected: 0, collected: 0, paid: 0 },
  );

  const body = `
<div class="section-title">Per-agent collections (daily active repaying tenants)</div>
${rows ? `<table><thead><tr><th class="right" style="width:4%">#</th><th style="width:20%">Agent Name</th><th style="width:14%">Agent Phone</th><th class="right">Repaying Tenants</th><th class="right">Expected</th><th class="right">Collected</th><th class="right">Rate</th><th class="right">Paid</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><td colspan="3">Totals · ${r.rows.length} agents</td><td class="right">${num(totals.tenants)}</td><td class="right">${ugx(totals.expected)}</td><td class="right">${ugx(totals.collected)}</td><td class="right">${pct(k.collection_rate)}</td><td class="right">${num(totals.paid)}</td><td>—</td></tr></tfoot></table>`
    : '<div class="empty">No collections or expectations recorded in this window.</div>'}`;

  return shell({
    title: 'Rent Collections Comprehensive Report',
    subtitle: 'Daily active repaying tenants — expected versus collected per agent',
    range: r.range,
    kpis: [
      { label: 'Total agents', value: num(k.total_agents) },
      { label: 'Active agents', value: num(k.active_agents) },
      { label: 'Repaying tenants', value: num(k.repaying_tenants) },
      { label: 'Expected', value: ugx(k.expected) },
      { label: 'Collected', value: ugx(k.collected) },
      { label: 'Collection rate', value: pct(k.collection_rate) },
    ],
    body,
  });
}

export function buildProductsReportHtml(r: ProductsReport): string {
  const k = r.kpis;
  const rows = r.rows
    .map(
      (p, i) => `<tr><td class="right">${i + 1}</td><td><strong>${esc(p.full_name || 'Unnamed agent')}</strong><br><span style="color:#64748B">${esc(p.phone || '—')}</span></td>
<td>${esc(p.product || '—')}${p.category ? `<br><span style="color:#64748B">${esc(p.category)}</span>` : ''}</td><td>${esc(p.status)}</td>
<td class="right">${ugx(p.value)}</td><td class="right">${ugx(p.recovered)}</td><td class="right">${ugx(p.outstanding)}</td><td>${day(p.date)}</td></tr>`,
    )
    .join('');
  const totals = r.rows.reduce(
    (a, p) => ({
      value: a.value + Number(p.value || 0),
      recovered: a.recovered + Number(p.recovered || 0),
      outstanding: a.outstanding + Number(p.outstanding || 0),
    }),
    { value: 0, recovered: 0, outstanding: 0 },
  );

  const body = `
<div class="section-title">Products &amp; services issued in the window</div>
${rows ? `<table><thead><tr><th class="right" style="width:4%">#</th><th style="width:22%">Agent Name &amp; Phone</th><th style="width:22%">Product</th><th>Status</th><th class="right">Value</th><th class="right">Recovered</th><th class="right">Outstanding</th><th>Date</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><td colspan="4">Totals · ${r.rows.length} records</td><td class="right">${ugx(totals.value)}</td><td class="right">${ugx(totals.recovered)}</td><td class="right">${ugx(totals.outstanding)}</td><td>—</td></tr></tfoot></table>`
    : '<div class="empty">No products or services issued in this window.</div>'}`;

  return shell({
    title: 'Agent Products & Services Report',
    subtitle: 'Smartphones, motorbikes and merchandise issued to agents, with recovery',
    range: r.range,
    kpis: [
      { label: 'Records', value: num(k.applications) },
      { label: 'Approved / issued', value: num(k.approved) },
      { label: 'Pending', value: num(k.pending) },
      { label: 'Value issued', value: ugx(k.value_issued) },
      { label: 'Recovered', value: ugx(k.recovered) },
      { label: 'Outstanding', value: ugx(k.outstanding) },
      { label: 'Recovery rate', value: pct(k.recovery_rate) },
    ],
    body,
  });
}

export function buildAdvancesReportHtml(r: AdvancesReport): string {
  const k = r.kpis;
  const stages = r.stages
    .map(
      (s) => `<tr><td>${esc(s.stage)}</td><td class="right">${num(s.count)}</td><td class="right">${pct(k.issued_count > 0 ? (s.count * 100) / k.issued_count : null)}</td><td class="right">${ugx(s.value)}</td><td class="right">${pct(k.volume > 0 ? (s.value * 100) / k.volume : null)}</td></tr>`,
    )
    .join('');
  const rows = r.rows
    .map(
      (a) => `<tr><td><strong>${esc(a.full_name || 'Unnamed agent')}</strong><br><span style="color:#64748B">${esc(a.phone || '—')}</span></td>
<td class="right">${ugx(a.disbursed)}</td><td class="right">${ugx(a.repaid)}</td><td class="right">${ugx(a.overdue)}</td><td class="right">${ugx(a.outstanding)}</td>
<td class="right">${pct(a.recovery_rate)}</td><td>${day(a.issued_at)}</td><td><span class="tag ${a.status === 'overdue' ? 'bad' : a.status === 'completed' ? 'ok' : 'warn'}">${esc(a.status || '—')}</span></td></tr>`,
    )
    .join('');
  const totals = r.rows.reduce(
    (acc, a) => ({
      d: acc.d + Number(a.disbursed || 0),
      r: acc.r + Number(a.repaid || 0),
      o: acc.o + Number(a.overdue || 0),
      out: acc.out + Number(a.outstanding || 0),
    }),
    { d: 0, r: 0, o: 0, out: 0 },
  );

  const body = `
<div class="section-title">Advance stage distribution</div>
${stages ? `<table><thead><tr><th>Application Stage / Status</th><th class="right">Count</th><th class="right">% of Count</th><th class="right">Financial Value</th><th class="right">% of Volume</th></tr></thead><tbody>${stages}</tbody>
<tfoot><tr><td>Totals</td><td class="right">${num(k.issued_count)}</td><td class="right">100.0%</td><td class="right">${ugx(k.volume)}</td><td class="right">100.0%</td></tr></tfoot></table>`
    : '<div class="empty">No advances issued in this window.</div>'}
<div class="section-title">Agent advance performance ledger</div>
${rows ? `<table><thead><tr><th style="width:24%">Agent Name &amp; Phone</th><th class="right">Disbursed</th><th class="right">Repaid</th><th class="right">Overdue</th><th class="right">Outstanding</th><th class="right">Recovery %</th><th>Issue Date</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><td>Totals · ${r.rows.length} advances</td><td class="right">${ugx(totals.d)}</td><td class="right">${ugx(totals.r)}</td><td class="right">${ugx(totals.o)}</td><td class="right">${ugx(totals.out)}</td><td class="right">${pct(totals.d > 0 ? (totals.r * 100) / totals.d : null)}</td><td>—</td><td>—</td></tr></tfoot></table>`
    : '<div class="empty">No advances issued in this window.</div>'}`;

  return shell({
    title: 'Agent Advances & Float Recovery Report',
    subtitle: 'Advance issuance, recovery and exposure across the window',
    range: r.range,
    kpis: [
      { label: 'Advance volume', value: ugx(k.volume) },
      { label: 'Advances issued', value: num(k.issued_count) },
      { label: 'Agents with advances', value: num(k.agents) },
      { label: 'Pending apps', value: num(k.pending_apps) },
      { label: 'Repaid in window', value: ugx(k.repaid) },
      { label: 'Outstanding balance', value: ugx(k.outstanding) },
      { label: 'Arrears', value: ugx(k.arrears) },
      { label: 'Recovery rate', value: pct(k.recovery_rate) },
    ],
    body,
  });
}

export function buildTeamCollectionsReportHtml(r: TeamCollectionsReport): string {
  const k = r.kpis;
  const rows = r.rows
    .map(
      (m) => `<tr><td><strong>${esc(m.full_name || 'Unnamed agent')}</strong>${m.is_leader ? ' <span class="tag ok">Leader</span>' : ''}<br><span style="color:#64748B">${esc(m.phone || '—')}</span></td>
<td class="right">${num(m.tenants)}</td><td class="right">${ugx(m.collected)}</td><td class="right">${pct(m.share_of_group_expected)}</td><td class="right">${num(m.payments)}</td><td>${dayTime(m.last_collection_at)}</td></tr>`,
    )
    .join('');

  const body = `
<div class="section-title">Sub-agent contributions</div>
${rows ? `<table><thead><tr><th style="width:26%">Agent Name &amp; Phone</th><th class="right">Tenants Count</th><th class="right">Amount Collected</th><th class="right">% vs Group Expected</th><th class="right">Collections</th><th>Latest collection</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><td>Totals · ${r.rows.length} members</td><td class="right">${num(k.tenants)}</td><td class="right">${ugx(k.collected)}</td><td class="right">${pct(k.rate)}</td><td>—</td><td>Expected: ${ugx(k.expected)}</td></tr></tfoot></table>`
    : '<div class="empty">No team members with activity in this window.</div>'}`;

  return shell({
    title: 'Team Collections & Sub-Agent Network Report',
    subtitle: 'Parent agent and sub-agent collections against expectation',
    range: r.range,
    subject: {
      heading: r.leader.full_name || 'Unnamed team leader',
      sub: `${r.leader.phone || 'No phone on record'} · ${k.sub_agents} sub-agents · Rank ${k.rank ?? '—'} of ${k.total_teams ?? '—'}`,
    },
    kpis: [
      { label: 'Team leader', value: esc(r.leader.full_name || '—') },
      { label: 'Total sub-agents', value: num(k.sub_agents) },
      { label: 'Total collected', value: ugx(k.collected) },
      { label: 'Expected target', value: ugx(k.expected) },
      { label: 'Rate', value: pct(k.rate) },
      { label: 'Rank', value: `${k.rank ?? '—'} / ${k.total_teams ?? '—'}` },
    ],
    body,
  });
}
