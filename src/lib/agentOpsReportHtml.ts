/**
 * Printable HTML export for the Comprehensive Agent Operations Report.
 *
 * Presentation only — every figure is passed in already formatted by the
 * caller, so nothing is recomputed or invented here.
 */

export interface ReportTile {
  label: string;
  value: string;
  hint?: string;
  tone?: 'positive' | 'negative';
}

export interface ReportTable {
  caption?: string;
  headers: string[];
  rows: (string | number)[][];
  footer?: (string | number)[];
  /** Column indexes rendered left-aligned instead of right-aligned. */
  leftAlign?: number[];
}

export interface ReportSection {
  title: string;
  note?: string;
  tiles?: ReportTile[];
  tables?: ReportTable[];
}

export interface AgentOpsReportInput {
  title: string;
  windowLabel: string;
  sourceNote?: string;
  sections: ReportSection[];
  watchlist?: string[];
  footerNote?: string;
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
:root{--primary:#6C21C4;--primary-dark:#4C1D95;--primary-light:#F3E8FF;--text-main:#0F172A;--text-body:#334155;--text-muted:#64748B;--bg-header:#F8FAFC;--bg-subtle:#F1F5F9;--border-color:#E2E8F0;--border-dark:#CBD5E1;--ok:#15803D;--bad:#B91C1C}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#E2E8F0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text-main);font-size:11px;line-height:1.45;-webkit-font-smoothing:antialiased}
.page{background:#fff;width:210mm;min-height:297mm;margin:12px auto;padding:14mm 12mm;box-shadow:0 6px 24px rgba(15,23,42,.16)}
.rail{background:var(--primary);color:#fff;border-radius:8px;padding:14px 16px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.rail h1{font-size:16px;font-weight:800;letter-spacing:-.2px}
.rail p{font-size:10px;opacity:.9;margin-top:3px}
.brand{font-size:13px;font-weight:900;letter-spacing:1px}
.meta{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
.meta span{background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:999px;padding:3px 9px;font-size:9.5px;color:var(--text-body);font-weight:600}
.section{margin-top:16px;page-break-inside:avoid}
.section-title{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:var(--primary-dark);border-bottom:2px solid var(--primary-light);padding-bottom:5px}
.section-note{margin-top:5px;font-size:9.5px;color:var(--text-muted)}
.kpis{margin-top:9px;display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}
.kpi{border:1px solid var(--border-color);border-radius:6px;padding:8px 10px}
.kpi-label{font-size:8.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-muted)}
.kpi-value{margin-top:3px;font-size:13px;font-weight:800;font-variant-numeric:tabular-nums}
.kpi-value.positive{color:var(--ok)}.kpi-value.negative{color:var(--bad)}
.kpi-hint{margin-top:2px;font-size:8.5px;color:var(--text-muted)}
.caption{margin:11px 0 5px;font-size:10px;font-weight:700;color:var(--text-body)}
table{width:100%;border-collapse:collapse;font-size:9.5px;font-variant-numeric:tabular-nums}
thead th{background:var(--bg-header);border-top:1px solid var(--border-dark);border-bottom:1px solid var(--border-dark);padding:6px;text-align:right;font-weight:700;color:var(--text-body);white-space:nowrap}
thead th:first-child{text-align:left}
tbody td{border-bottom:1px solid var(--border-color);padding:5px 6px;color:var(--text-body);text-align:right}
tbody td.left,thead th.left{text-align:left}
tbody tr:nth-child(even) td{background:#FCFCFD}
tfoot td{border-top:2px solid var(--border-dark);padding:6px;font-weight:800;background:var(--bg-subtle);color:var(--text-main);text-align:right}
tfoot td.left{text-align:left}
.empty{padding:12px;text-align:center;color:var(--text-muted);font-size:10px;border:1px dashed var(--border-dark);border-radius:6px}
.watchlist{margin-top:16px;border:1px solid #FDE68A;background:#FFFBEB;border-radius:6px;padding:10px 12px}
.watchlist h3{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#92400E}
.watchlist li{margin-top:5px;margin-left:14px;font-size:9.5px;color:#78350F}
.foot{margin-top:16px;border-top:1px solid var(--border-color);padding-top:6px;font-size:8.5px;color:var(--text-muted)}
@page{size:A4;margin:10mm}
@media print{body{background:#fff}.page{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}thead{display:table-header-group}tr{page-break-inside:avoid}}
`;

function renderTable(t: ReportTable): string {
  const left = new Set(t.leftAlign ?? [0]);
  const cls = (i: number) => (left.has(i) ? ' class="left"' : '');
  const head = t.headers.map((h, i) => `<th${cls(i)}>${esc(h)}</th>`).join('');
  const body = t.rows.length
    ? t.rows
        .map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${esc(c)}</td>`).join('')}</tr>`)
        .join('')
    : `<tr><td class="left" colspan="${t.headers.length}" style="text-align:center;color:#64748B">No qualifying records in this period.</td></tr>`;
  const foot = t.footer
    ? `<tfoot><tr>${t.footer.map((c, i) => `<td${cls(i)}>${esc(c)}</td>`).join('')}</tr></tfoot>`
    : '';
  return `${t.caption ? `<div class="caption">${esc(t.caption)}</div>` : ''}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

function renderSection(s: ReportSection): string {
  const tiles = s.tiles?.length
    ? `<div class="kpis">${s.tiles
        .map(
          (t) => `<div class="kpi"><div class="kpi-label">${esc(t.label)}</div><div class="kpi-value${t.tone ? ` ${t.tone}` : ''}">${esc(t.value)}</div>${t.hint ? `<div class="kpi-hint">${esc(t.hint)}</div>` : ''}</div>`,
        )
        .join('')}</div>`
    : '';
  const tables = (s.tables ?? []).map(renderTable).join('');
  return `<div class="section"><div class="section-title">${esc(s.title)}</div>${s.note ? `<p class="section-note">${esc(s.note)}</p>` : ''}${tiles}${tables}</div>`;
}

/** Builds the standalone printable HTML document for the comprehensive report. */
export function buildAgentOpsReportHtml(input: AgentOpsReportInput): string {
  const watch = (input.watchlist ?? []).filter(Boolean);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welile — ${esc(input.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="page">
<div class="rail"><div><h1>${esc(input.title)}</h1><p>${esc(input.windowLabel)}</p></div><div style="text-align:right"><div class="brand">WELILE</div><p style="font-size:9px;opacity:.85">Agent Operations</p></div></div>
<div class="meta"><span>Window: ${esc(input.windowLabel)}</span>${input.sourceNote ? `<span>${esc(input.sourceNote)}</span>` : ''}<span>Currency: UGX</span></div>
${input.sections.map(renderSection).join('')}
${watch.length ? `<div class="watchlist"><h3>Watchlist</h3><ul>${watch.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
${input.footerNote ? `<div class="foot">${esc(input.footerNote)}</div>` : ''}
</div></body></html>`;
}

/** Saves the built HTML report as a downloadable file. */
export function downloadAgentOpsReportHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
