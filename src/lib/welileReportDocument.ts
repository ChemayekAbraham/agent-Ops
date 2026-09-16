/**
 * The Welile A4 report document kit.
 *
 * One stylesheet and one page scaffold, shared by every printable report in
 * the product. It emits the `welile/email/reports/*.html` templates: an A4
 * `.report-page`, the purple document header, KPI cards, tables and the
 * confidential footer.
 *
 * Rendering contract
 * ------------------
 * The SAME HTML string is used for both the on-screen preview and the PDF: the
 * preview is an `<iframe srcDoc={html}>` and "PDF" calls `print()` on that very
 * frame (`printReportFrame`). There is no second, separately-built document, so
 * what is exported is byte-for-byte what was previewed. A report that draws
 * itself a second time - in jsPDF, say - is off this contract and will drift
 * from the designed template.
 *
 * Presentation only. Nothing here queries, and nothing derives a money figure:
 * callers pass values already formatted or already aggregated server-side.
 *
 * Extracted from `agentOpsOverviewReportHtml.ts`, which declared all of this
 * privately and so kept it out of reach of every other report.
 */

export const DASH = '—';

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const n = (v: number | null | undefined): number => Number(v ?? 0);

export const ugx = (v: number | null | undefined): string =>
  `UGX ${Math.round(n(v)).toLocaleString('en-US')}`;

/** Compact UGX for dense chart-summary cells (e.g. "UGX 14.6M"). */
export const ugxShort = (v: number | null | undefined): string => {
  const x = Math.abs(n(v));
  if (x >= 1_000_000) return `UGX ${(n(v) / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `UGX ${(n(v) / 1_000).toFixed(0)}K`;
  return `UGX ${Math.round(n(v))}`;
};

export const num = (v: number | null | undefined): string => Math.round(n(v)).toLocaleString('en-US');

export const pct = (v: number | null | undefined): string => (v == null ? DASH : `${Number(v).toFixed(1)}%`);

export const day = (v: string | null | undefined): string => {
  if (!v) return DASH;
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? DASH
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const dayTime = (v: string | null | undefined): string => {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} • ${d.toLocaleTimeString(
    'en-GB',
    { hour: '2-digit', minute: '2-digit' },
  )}`;
};


/** Safe JSON for an inline <script> payload. */
export const payload = (v: unknown): string =>
  JSON.stringify(v ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));


/* -------------------------------------------------------------------- styles */

/**
 * One stylesheet for all reports — the union of the four source templates.
 * Kept verbatim in spirit (same tokens, sizes and print rules) so the exported
 * PDF matches the designed A4 document.
 */
export const REPORT_CSS = `
:root{
  --primary:#7B19D4; --primary-dark:#581C87; --primary-light:#F3E8FF; --primary-hover:#6D14BD;
  --accent-cyan:#0284C7; --accent-cyan-bg:#E0F2FE;
  --text-main:#0F172A; --text-body:#334155; --text-muted:#64748B; --text-light:#94A3B8;
  --bg-document:#FFFFFF; --bg-header:#F8FAFC; --bg-subtle:#F1F5F9;
  --border-color:#E2E8F0; --border-dark:#CBD5E1;
  --status-success:#15803D; --status-success-bg:#F0FDF4; --status-success-border:#BBF7D0;
  --status-warning:#B45309; --status-warning-bg:#FFFBEB; --status-warning-border:#FDE68A;
  --status-danger:#B91C1C; --status-danger-bg:#FEF2F2; --status-danger-border:#FECACA;
  --font-sans:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,monospace;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{background-color:#E2E8F0;font-family:var(--font-sans);color:var(--text-main);font-size:11px;line-height:1.4;-webkit-font-smoothing:antialiased}
.num,.currency,.pct,.date{font-feature-settings:"tnum" 1,"zero" 1;font-variant-numeric:tabular-nums}
.font-mono{font-family:var(--font-mono)}
.tone-excellent{color:var(--status-success)}
.tone-target{color:var(--status-success)}
.tone-attention{color:var(--status-warning)}
.tone-critical{color:var(--status-danger)}
.tone-muted{color:var(--text-muted)}

/* A4 document */
.document-wrapper{max-width:210mm;margin:16px auto 32px auto}
.report-page{width:210mm;min-height:297mm;background-color:var(--bg-document);padding:16mm 16mm 18mm 16mm;margin-bottom:24px;box-shadow:0 4px 15px rgba(0,0,0,.08);position:relative;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;page-break-after:always;break-after:page}
.page-content{flex:1}
.report-footer{display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid var(--border-color);font-size:8.5px;color:var(--text-muted);font-weight:500}
.avoid-break{break-inside:avoid;page-break-inside:avoid}

/* Document header */
.pdf-header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--text-main);padding-bottom:12px;margin-bottom:14px;gap:16px}
.pdf-header-left{display:flex;flex-direction:column;gap:2px}
.company-name{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--primary)}
.report-title-main{font-size:18px;font-weight:900;color:var(--text-main);letter-spacing:-.4px;margin-top:2px}
.report-subtitle-main{font-size:9.5px;color:var(--text-muted)}
.pdf-header-meta-table{font-size:9px;border-collapse:collapse;flex-shrink:0}
.pdf-header-meta-table td{padding:1.5px 6px;text-align:right;white-space:nowrap}
.pdf-header-meta-table td.meta-lbl{color:var(--text-muted);font-weight:600;text-transform:uppercase}
.pdf-header-meta-table td.meta-val{font-weight:700;color:var(--text-main)}

/* Entity hero card (agent profile / team leader) */
.entity-card{background:linear-gradient(135deg,#FAF5FF 0%,#F5F3FF 100%);border:1px solid #E9D5FF;border-radius:6px;padding:12px 16px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:16px}
.entity-info{flex:1;min-width:0}
.entity-header-row{display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap}
.entity-eyebrow{font-size:8px;font-weight:800;text-transform:uppercase;color:var(--primary);letter-spacing:.6px}
.entity-info h2{font-size:15.5px;font-weight:800;color:var(--primary-dark);margin:0 0 4px 0;letter-spacing:-.2px}
.entity-phone{font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text-main);margin-bottom:2px;letter-spacing:.3px}
.entity-meta{font-size:9px;color:var(--text-muted)}
.entity-meta strong{color:var(--text-body);font-weight:700}
.entity-stats{display:flex;align-items:stretch;gap:8px;flex-shrink:0}
.entity-stat-pill{background:#FFF;border:1px solid #E2E8F0;padding:8px 12px;border-radius:5px;min-width:125px;text-align:right;box-shadow:0 1px 2px rgba(0,0,0,.02);display:flex;flex-direction:column;justify-content:center}
.entity-stat-pill .label{font-size:7.5px;font-weight:800;text-transform:uppercase;color:var(--text-muted);letter-spacing:.4px;margin-bottom:2px}
.entity-stat-pill .val{font-size:13.5px;font-weight:800;color:var(--primary);line-height:1.2}
.entity-stat-pill .stat-sub{font-size:8px;color:var(--text-muted);margin-top:2px;white-space:nowrap}

/* KPI cards */
.kpi-grid{display:grid;gap:8px;margin-bottom:12px}
.kpi-grid-4{grid-template-columns:repeat(4,1fr)}
.kpi-grid-5{grid-template-columns:repeat(5,1fr)}
.kpi-grid-6{grid-template-columns:repeat(6,1fr)}
.kpi-card{background-color:var(--bg-header);border:1px solid var(--border-color);padding:8px 10px;border-radius:4px;text-align:center}
.kpi-card .kpi-label{font-size:8px;font-weight:800;text-transform:uppercase;color:var(--text-muted);letter-spacing:.3px;margin-bottom:3px}
.kpi-card .kpi-value{font-size:12.5px;font-weight:900;color:var(--text-main);word-break:break-word}
.kpi-card .kpi-sub{font-size:8px;color:var(--text-muted);margin-top:3px}
.kpi-card.primary .kpi-value{color:var(--primary)}
.kpi-card.success .kpi-value{color:var(--status-success)}
.kpi-card.warning .kpi-value{color:var(--status-warning)}
.kpi-card.danger .kpi-value{color:var(--status-danger)}

/* Sections */
.section-title{font-size:11.5px;font-weight:800;color:var(--text-main);border-bottom:1px solid var(--border-dark);padding-bottom:3px;margin-top:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.section-title .section-note{font-size:8px;font-weight:600;color:var(--text-muted)}
.section-subtitle{font-size:8.5px;color:var(--text-muted);margin-top:-2px;margin-bottom:8px}

/* Tables */
.report-table{width:100%;border-collapse:collapse;font-size:8.5px;margin-bottom:10px}
.report-table thead{display:table-header-group}
.report-table th{background-color:var(--bg-header);color:var(--text-muted);font-weight:700;text-transform:uppercase;font-size:7.5px;letter-spacing:.4px;padding:4px 6px;border-top:1px solid var(--border-dark);border-bottom:1.5px solid var(--border-dark);text-align:left}
.report-table th.right,.report-table td.right{text-align:right}
.report-table td{padding:4px 6px;border-bottom:1px solid var(--border-color);color:var(--text-main);vertical-align:top}
.report-table tbody tr:nth-child(even) td{background-color:#FAFAFA}
.report-table tr.highlight-danger td{background-color:#FEF2F2 !important}
.report-table tr.total-row td,.report-table tfoot tr td{background-color:#F8FAFC !important;font-weight:800;border-top:1.5px solid var(--text-main);border-bottom:2px solid var(--text-main)}
.cell-strong{font-weight:700;color:var(--text-main)}
.cell-sub{font-size:8px;color:var(--text-muted);white-space:nowrap}
.nowrap{white-space:nowrap}
.empty-row td{text-align:center;color:var(--text-muted);padding:14px 6px;font-style:italic}

/* Badges */
.doc-badge{display:inline-block;padding:1.5px 5px;border-radius:3px;font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.badge-pass,.badge-excellent{background-color:#DCFCE7;color:#166534;border:1px solid #86EFAC}
.badge-target{background-color:var(--status-success-bg);color:var(--status-success);border:1px solid var(--status-success-border)}
.badge-warn,.badge-attention{background-color:var(--status-warning-bg);color:var(--status-warning);border:1px solid var(--status-warning-border)}
.badge-fail,.badge-critical{background-color:var(--status-danger-bg);color:var(--status-danger);border:1px solid var(--status-danger-border)}
.badge-info{background-color:#E0F2FE;color:#0369A1;border:1px solid #BAE6FD}
.badge-primary{background-color:var(--primary-light);color:var(--primary-dark);border:1px solid #DDD6FE}
.badge-gold{background-color:#FEF3C7;color:#92400E;border:1px solid #FCD34D}
.badge-silver{background-color:#F1F5F9;color:#334155;border:1px solid #CBD5E1}
.badge-bronze{background-color:#FFEDD5;color:#9A3412;border:1px solid #FDBA74}

/* Charts */
.chart-container-block{border:1px solid var(--border-color);background-color:#FFF;padding:8px 10px;margin-bottom:10px}
.chart-header-title{font-size:9.5px;font-weight:800;color:var(--text-main)}
.chart-header-sub{font-size:8px;color:var(--text-muted);margin-bottom:4px}
.chart-canvas-area{position:relative;width:100%;height:130px}
.chart-grid-2col{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.chart-grid-2col.wide-left{grid-template-columns:1.2fr .8fr}
.chart-summary-cap{font-size:7.5px;font-weight:800;text-transform:uppercase;color:var(--text-muted);margin-top:6px;margin-bottom:2px}

/* Callouts */
.observation-callout{background-color:#F8FAFC;border:1px solid var(--border-dark);border-left:3.5px solid var(--primary);padding:6px 10px;font-size:8.5px;margin-top:6px;margin-bottom:8px}
.observation-callout strong{color:var(--text-main);font-weight:800}
.directive-box{margin-top:10px;border:1px solid var(--border-color);padding:8px 12px;background-color:var(--bg-header);font-size:8.5px}
.directive-box .directive-title{font-weight:800;text-transform:uppercase;color:var(--primary);margin-bottom:2px}
.directive-box p{color:var(--text-body);line-height:1.4}
.directive-signoff{display:flex;justify-content:space-between;gap:12px;margin-top:6px;padding-top:4px;border-top:1px dashed var(--border-dark);font-weight:700;flex-wrap:wrap}

/* Tenant ledger blocks */
.tenant-history-section{display:flex;flex-direction:column;gap:14px;margin-top:8px}
.tenant-card-block{border:1px solid var(--border-color);background-color:#FFF;border-radius:6px;overflow:hidden;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.03)}
.tenant-card-header{background:linear-gradient(135deg,#F8FAFC 0%,#F1F5F9 100%);border-bottom:1px solid var(--border-color);padding:8px 12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.tenant-name-title{font-size:12px;font-weight:800;color:var(--text-main);display:flex;align-items:center;gap:8px}
.tenant-bio-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:8px 12px;background-color:#FAFAFA;border-bottom:1px solid var(--border-color);font-size:8px}
.bio-item{display:flex;flex-direction:column;gap:1px;min-width:0}
.bio-lbl{color:var(--text-muted);font-weight:700;text-transform:uppercase;font-size:7px;letter-spacing:.3px}
.bio-val{font-weight:600;color:var(--text-main);overflow-wrap:anywhere}
.tenant-kpi-bar{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:6px 12px;background-color:#FAF5FF;border-bottom:1px solid #E9D5FF}
.tenant-kpi-pill{text-align:center}
.tenant-kpi-pill .t-lbl{font-size:7px;font-weight:800;text-transform:uppercase;color:var(--text-muted)}
.tenant-kpi-pill .t-val{font-size:11px;font-weight:800;color:var(--primary-dark)}

@media print{
  @page{size:A4 portrait;margin:12mm 12mm 14mm 12mm}
  html,body{background-color:#FFF !important;font-size:9pt !important}
  .document-wrapper{margin:0 !important;max-width:100% !important}
  .report-page{width:100% !important;min-height:auto !important;box-shadow:none !important;padding:0 !important;margin-bottom:0 !important;break-after:page !important;page-break-after:always !important}
  .report-page:last-child{break-after:auto !important;page-break-after:auto !important}
  .report-table th,.report-table td{border-bottom:1px solid #CBD5E1 !important}
  .entity-card,.tenant-card-header,.tenant-kpi-bar,.kpi-card,.report-table th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .tenant-card-block{break-inside:avoid;page-break-inside:avoid;margin-bottom:10px}
}
`;


/* ------------------------------------------------------------- scaffolding */

export interface MetaRow {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
}

export const TONE_COLOR = {
  ok: 'var(--status-success)',
  warn: 'var(--status-warning)',
  bad: 'var(--status-danger)',
} as const;

export function docHeader(opts: { title: string; subtitle: string; meta: MetaRow[] }): string {
  const rows = opts.meta
    .map(
      (m) =>
        `<tr><td class="meta-lbl">${esc(m.label)}</td><td class="meta-val"${
          m.tone ? ` style="color:${TONE_COLOR[m.tone]}"` : ''
        }>${esc(m.value)}</td></tr>`,
    )
    .join('');
  return `<header class="pdf-header">
  <div class="pdf-header-left">
    <span class="company-name">Welile Technologies Limited</span>
    <h1 class="report-title-main">${esc(opts.title)}</h1>
    <div class="report-subtitle-main">${esc(opts.subtitle)}</div>
  </div>
  <table class="pdf-header-meta-table">${rows}</table>
</header>`;
}

export interface Kpi {
  label: string;
  value: string;
  sub?: string;
  variant?: 'primary' | 'success' | 'warning' | 'danger';
}

export const kpiGrid = (items: Kpi[], cols: 4 | 5 | 6): string =>
  `<div class="kpi-grid kpi-grid-${cols}">${items
    .map(
      (k) =>
        `<div class="kpi-card${k.variant ? ` ${k.variant}` : ''}"><div class="kpi-label">${esc(
          k.label,
        )}</div><div class="kpi-value num">${esc(k.value)}</div>${
          k.sub ? `<div class="kpi-sub">${esc(k.sub)}</div>` : ''
        }</div>`,
    )
    .join('')}</div>`;

export const sectionTitle = (title: string, note?: string): string =>
  `<div class="section-title"><span>${esc(title)}</span>${
    note ? `<span class="section-note">${esc(note)}</span>` : ''
  }</div>`;

/** A table with an optional footer; renders an explicit empty state. */
export function table(opts: {
  id?: string;
  head: string;
  rows: string[];
  foot?: string;
  colspan: number;
  emptyText?: string;
}): string {
  const body = opts.rows.length
    ? opts.rows.join('')
    : `<tr class="empty-row"><td colspan="${opts.colspan}">${esc(
        opts.emptyText ?? 'No records in the selected window.',
      )}</td></tr>`;
  return `<table class="report-table"${opts.id ? ` id="${opts.id}"` : ''}>
  <thead>${opts.head}</thead>
  <tbody>${body}</tbody>
  ${opts.foot && opts.rows.length ? `<tfoot>${opts.foot}</tfoot>` : ''}
</table>`;
}

/** Chart block + its always-present data-summary table (PDF-safe). */
export function chartBlock(opts: {
  canvasId: string;
  title: string;
  subtitle: string;
  summaryCaption: string;
  head: string;
  rows: string[];
  foot?: string;
  colspan: number;
}): string {
  return `<div class="chart-container-block avoid-break">
  <div class="chart-header-title">${esc(opts.title)}</div>
  <div class="chart-header-sub">${esc(opts.subtitle)}</div>
  <div class="chart-canvas-area"><canvas id="${opts.canvasId}"></canvas></div>
  <div class="chart-summary-cap">${esc(opts.summaryCaption)}</div>
  ${table({ head: opts.head, rows: opts.rows, foot: opts.foot, colspan: opts.colspan })}
</div>`;
}

export const page = (content: string, footerRight: string): string =>
  `<article class="report-page"><div class="page-content">${content}</div>
<footer class="report-footer"><span>Welile Technologies Limited • Confidential Financial Operations</span><span>${esc(
    footerRight,
  )}</span></footer></article>`;

/** Full standalone document. `charts` is handed to the inline bootstrap. */
export function shell(opts: {
  title: string;
  pages: string[];
  charts?: unknown;
  /**
   * Extra rules for this document only, appended after the shared stylesheet.
   * For density a particular report needs (a statement fits more on a sheet
   * than an ops report does) without editing the stylesheet every other report
   * depends on.
   */
  extraCss?: string;
  /**
   * A document with no charts at all. Skips the Chart.js CDN tag and the
   * bootstrap entirely, so a statement a partner opens offline pulls nothing
   * from the network. `__WELILE_READY__` is still set, for anything that waits
   * on it. Callers that draw charts leave this alone.
   */
  noCharts?: boolean;
}): string {
  if (opts.noCharts) {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${REPORT_CSS}</style>${opts.extraCss ? `
<style>${opts.extraCss}</style>` : ''}
</head><body>
<main class="document-wrapper">${opts.pages.join('')}</main>
<script>window.__WELILE_READY__ = true;</script>
</body></html>`;
  }
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>${REPORT_CSS}</style>${opts.extraCss ? `
<style>${opts.extraCss}</style>` : ''}
</head><body>
<main class="document-wrapper">${opts.pages.join('')}</main>
<script>
window.__WELILE_CHARTS__ = ${payload(opts.charts ?? [])};
(function () {
  function done() { window.__WELILE_READY__ = true; }
  function draw() {
    if (typeof Chart === 'undefined') return done();
    var specs = window.__WELILE_CHARTS__ || [];
    var tick = { font: { size: 8, family: 'Inter' } };
    for (var i = 0; i < specs.length; i++) {
      var s = specs[i];
      var el = document.getElementById(s.canvas);
      if (!el) continue;
      var money = s.money !== false;
      try {
        new Chart(el.getContext('2d'), {
          type: s.type,
          data: { labels: s.labels, datasets: s.datasets },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: {
              legend: s.type === 'doughnut'
                ? { position: 'right', labels: { boxWidth: 8, font: { size: 7.5, family: 'Inter' } } }
                : { position: 'top', labels: { boxWidth: 10, font: { size: 8.5, family: 'Inter' } } },
              tooltip: { callbacks: { label: function (c) {
                var v = c.parsed && c.parsed.y != null ? c.parsed.y : c.parsed;
                var lbl = c.dataset.label ? c.dataset.label + ': ' : (c.label ? c.label + ': ' : '');
                return lbl + (money ? 'UGX ' + v + 'M' : v);
              } } }
            },
            scales: s.type === 'doughnut' ? {} : {
              y: { stacked: !!s.stacked, beginAtZero: true,
                   ticks: { font: { size: 8, family: 'JetBrains Mono' },
                            callback: function (v) { return money ? v + 'M' : v; } },
                   grid: { color: '#E2E8F0' } },
              x: { stacked: !!s.stacked, ticks: tick, grid: { display: false } }
            },
            cutout: s.type === 'doughnut' ? '60%' : undefined
          }
        });
      } catch (e) { /* summary tables already carry the numbers */ }
    }
    done();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
})();
</script>
</body></html>`;
}


/* ------------------------------------------------------------- printing */

/**
 * Print the exact document the user is previewing.
 *
 * The preview iframe *is* the print target, so the PDF is the same DOM, same
 * stylesheet and same rendered charts — there is no second build step that
 * could drift. Returns false when the frame is not usable, so the caller can
 * fall back to `printReportHtml`.
 */
export function printReportFrame(frame: HTMLIFrameElement | null): boolean {
  const win = frame?.contentWindow;
  if (!win) return false;
  try {
    win.focus();
    win.print();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback path: render `html` into a popup and print it. Used only when the
 * preview frame is unavailable (e.g. not yet mounted).
 */
export function printReportHtml(html: string, fileTitle: string): void {
  const w = window.open('', '_blank');
  if (!w) {
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
  }, 600);
}
