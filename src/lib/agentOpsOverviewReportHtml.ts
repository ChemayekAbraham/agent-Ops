/**
 * Agent Operations → Reports → Overview: report document builders.
 *
 * These emit the Welile A4 report templates (`welile/email/reports/*.html`)
 * bound to live server-aggregated figures. One shared stylesheet + one page
 * scaffold serves every report, so the four report types cannot drift apart.
 *
 * Rendering contract
 * ------------------
 * The same HTML string is used for BOTH the on-screen preview and the PDF: the
 * preview is an `<iframe srcDoc={html}>` and "PDF" calls `print()` on that very
 * frame (`printReportFrame`). There is no second, separately-built document, so
 * what is exported is byte-for-byte what was previewed.
 *
 * Data contract
 * -------------
 * Every figure here already arrives aggregated from one RPC round-trip (see
 * `useAgentOpsReports`). Nothing in this file re-queries, and nothing derives a
 * money figure the server did not send — the only client-side maths are column
 * totals over rows already in hand and the tier histogram, both pure folds over
 * a single in-memory array (no fan-out, no per-row work).
 *
 * Charts are progressive enhancement: every chart is paired with a "CHART DATA
 * SUMMARY" table carrying the same numbers, so a blocked CDN degrades the
 * document's looks but never its content.
 */
import type {
  AdvancesReport,
  AgentReport,
  ProductsReport,
  RentCollectionsReport,
  TeamCollectionsReport,
} from '@/hooks/useAgentOpsReports';

/* ---------------------------------------------------------------- formatters */

const DASH = '—';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const n = (v: number | null | undefined): number => Number(v ?? 0);

const ugx = (v: number | null | undefined): string =>
  `UGX ${Math.round(n(v)).toLocaleString('en-US')}`;

/** Compact UGX for dense chart-summary cells (e.g. "UGX 14.6M"). */
const ugxShort = (v: number | null | undefined): string => {
  const x = Math.abs(n(v));
  if (x >= 1_000_000) return `UGX ${(n(v) / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `UGX ${(n(v) / 1_000).toFixed(0)}K`;
  return `UGX ${Math.round(n(v))}`;
};

const num = (v: number | null | undefined): string => Math.round(n(v)).toLocaleString('en-US');

const pct = (v: number | null | undefined): string => (v == null ? DASH : `${Number(v).toFixed(1)}%`);

const day = (v: string | null | undefined): string => {
  if (!v) return DASH;
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? DASH
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const dayTime = (v: string | null | undefined): string => {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} • ${d.toLocaleTimeString(
    'en-GB',
    { hour: '2-digit', minute: '2-digit' },
  )}`;
};

/**
 * Performance ladder.
 *
 * These thresholds MIRROR the SQL in `agent_ops_report_rent_collections`
 * verbatim — do not invent new ones here:
 *
 *   collected <= 0  -> 'Silent'        rate >= 100 -> 'Excellent'
 *   rate IS NULL    -> 'Unscheduled'   rate >=  75 -> 'On track'
 *                                      rate >=  50 -> 'Fair'
 *                                      else        -> 'Behind'
 *
 * Where a row already carries a server `status`, that string is rendered
 * verbatim (`statusBadge`) so the document can never contradict the database.
 * `rateTier` is only for rate-only rows the server does not classify (period
 * sub-totals, aggregate footers), and it uses the same cut-offs so the two
 * always agree.
 */
type Tier = 'excellent' | 'ontrack' | 'fair' | 'behind' | 'silent' | 'unscheduled';

const TIER_LABEL: Record<Tier, string> = {
  excellent: 'Excellent',
  ontrack: 'On track',
  fair: 'Fair',
  behind: 'Behind',
  silent: 'Silent',
  unscheduled: 'Unscheduled',
};

/** Badge CSS class per tier (see REPORT_CSS). */
const TIER_BADGE: Record<Tier, string> = {
  excellent: 'excellent',
  ontrack: 'target',
  fair: 'attention',
  behind: 'critical',
  silent: 'critical',
  unscheduled: 'info',
};

/** Presentation order, worst-to-best readability for legends and tables. */
const TIER_ORDER: Tier[] = ['excellent', 'ontrack', 'fair', 'behind', 'silent', 'unscheduled'];

/** The cut-off each tier represents, spelled out for report readers. */
const TIER_RANGE: Record<Tier, string> = {
  excellent: '≥ 100%',
  ontrack: '75–99%',
  fair: '50–74%',
  behind: '< 50%',
  silent: 'nothing collected',
  unscheduled: 'no expected amount',
};

/** Chart slice colour per tier. */
const TIER_COLOR: Record<Tier, string> = {
  excellent: '#16A34A',
  ontrack: '#22C55E',
  fair: '#EAB308',
  behind: '#DC2626',
  silent: '#991B1B',
  unscheduled: '#0EA5E9',
};

/** Text-colour class per tier. */
const TIER_TONE: Record<Tier, string> = {
  excellent: 'tone-excellent',
  ontrack: 'tone-target',
  fair: 'tone-attention',
  behind: 'tone-critical',
  silent: 'tone-critical',
  unscheduled: 'tone-muted',
};

/** Rate-only classification, mirroring the SQL cut-offs above. */
const rateTier = (rate: number | null | undefined): Tier => {
  if (rate == null) return 'unscheduled';
  const r = Number(rate);
  if (r >= 100) return 'excellent';
  if (r >= 75) return 'ontrack';
  if (r >= 50) return 'fair';
  return 'behind';
};

/** Resolve the server's status label onto the shared tone vocabulary. */
const tierOfStatus = (status: string | null | undefined, rate: number | null | undefined): Tier => {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'excellent': return 'excellent';
    case 'on track': return 'ontrack';
    case 'fair': return 'fair';
    case 'behind': return 'behind';
    case 'silent': return 'silent';
    case 'unscheduled': return 'unscheduled';
    // Unknown label from a newer server build: fall back to the mirrored ladder
    // rather than mislabelling the row.
    default: return rateTier(rate);
  }
};

/** Percentage cell, tinted to match the row's status. */
const rateCell = (rate: number | null | undefined, status?: string | null): string => {
  const t = status === undefined ? rateTier(rate) : tierOfStatus(status, rate);
  return `<span class="pct ${TIER_TONE[t]}" style="font-weight:800;">${pct(rate)}</span>`;
};

/** Badge for a row the server classified — prints the server's own wording. */
const statusBadge = (status: string | null | undefined, rate: number | null | undefined): string => {
  const t = tierOfStatus(status, rate);
  const label = (status ?? '').trim() || TIER_LABEL[t];
  return `<span class="doc-badge badge-${TIER_BADGE[t]}">${esc(label)}</span>`;
};

/** Badge for a rate the server did not classify (footers, KPI headers). */
const rateBadge = (rate: number | null | undefined): string => {
  const t = rateTier(rate);
  return `<span class="doc-badge badge-${TIER_BADGE[t]}">${TIER_LABEL[t]}</span>`;
};

/** Safe JSON for an inline <script> payload. */
const payload = (v: unknown): string =>
  JSON.stringify(v ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));

/**
 * Humanise a stored collection channel for the ledger ("agent_float" →
 * "Agent Float"). Unknown values are title-cased rather than dropped, so a new
 * channel added server-side still reads sensibly without a code change.
 */
const channelLabel = (v: string | null | undefined): string => {
  const s = (v ?? '').trim();
  if (!s) return DASH;
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bMomo\b/gi, 'MoMo')
    .replace(/\bMtn\b/gi, 'MTN')
    .replace(/\bSms\b/gi, 'SMS');
};

const rangeLabel = (r: { from: string; to: string } | undefined): string =>
  r ? `${day(r.from)} – ${day(r.to)}` : DASH;

/** Deterministic audit reference from the report kind + window. */
const auditRef = (kind: string, r: { from: string; to: string } | undefined): string =>
  `W-${kind}-${(r?.to ?? '').replace(/-/g, '') || 'NA'}`;

/* -------------------------------------------------------------------- styles */

/**
 * One stylesheet for all reports — the union of the four source templates.
 * Kept verbatim in spirit (same tokens, sizes and print rules) so the exported
 * PDF matches the designed A4 document.
 */
const REPORT_CSS = `
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

interface MetaRow {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
}

const TONE_COLOR = {
  ok: 'var(--status-success)',
  warn: 'var(--status-warning)',
  bad: 'var(--status-danger)',
} as const;

function docHeader(opts: { title: string; subtitle: string; meta: MetaRow[] }): string {
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

interface Kpi {
  label: string;
  value: string;
  sub?: string;
  variant?: 'primary' | 'success' | 'warning' | 'danger';
}

const kpiGrid = (items: Kpi[], cols: 4 | 5 | 6): string =>
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

const sectionTitle = (title: string, note?: string): string =>
  `<div class="section-title"><span>${esc(title)}</span>${
    note ? `<span class="section-note">${esc(note)}</span>` : ''
  }</div>`;

/** A table with an optional footer; renders an explicit empty state. */
function table(opts: {
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
function chartBlock(opts: {
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

const page = (content: string, footerRight: string): string =>
  `<article class="report-page"><div class="page-content">${content}</div>
<footer class="report-footer"><span>Welile Technologies Limited • Confidential Financial Operations</span><span>${esc(
    footerRight,
  )}</span></footer></article>`;

/** Full standalone document. `charts` is handed to the inline bootstrap. */
function shell(opts: { title: string; pages: string[]; charts?: unknown }): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>${REPORT_CSS}</style>
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

/** Millions, for chart series. */
const toM = (v: number | null | undefined): number => Number((n(v) / 1_000_000).toFixed(2));

const SERIES = {
  expected: { label: 'Expected', borderColor: '#64748B', backgroundColor: 'rgba(100,116,139,.10)', borderWidth: 1.5, borderDash: [4, 4], pointRadius: 3, fill: false, tension: 0.2 },
  collected: { label: 'Collected', borderColor: '#15803D', backgroundColor: 'rgba(21,128,61,.12)', borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#15803D', fill: true, tension: 0.2 },
} as const;

/* -------------------------------------------------------- 1. Agent report */

export function buildAgentReportHtml(r: AgentReport): string {
  const k = r.kpis;
  const tenants = r.tenants ?? [];
  const periods = r.periods ?? [];

  // Column totals: a single fold over rows already in hand.
  const t = tenants.reduce(
    (a, x) => ({
      rent: a.rent + n(x.rent_amount),
      out: a.out + n(x.outstanding),
      rep: a.rep + n(x.repayment),
      col: a.col + n(x.collected),
      ctd: a.ctd + n(x.collected_to_date),
      pay: a.pay + n(x.payments),
    }),
    { rent: 0, out: 0, rep: 0, col: 0, ctd: 0, pay: 0 },
  );

  const p1 = [
    docHeader({
      title: 'Agent Performance & Tenant Collections Report',
      subtitle: 'Individual Agent Portfolio Reconciliation & Rent Repayment Audit',
      meta: [
        { label: 'Report Period', value: rangeLabel(r.range) },
        { label: 'Generated On', value: dayTime(new Date().toISOString()) },
        { label: 'Audit Ref ID', value: auditRef('AGR', r.range) },
        { label: 'Window Rate', value: pct(k?.window_rate), tone: rateTier(k?.window_rate) === 'behind' ? 'bad' : 'ok' },
      ],
    }),
    `<div class="entity-card">
      <div class="entity-info">
        <div class="entity-header-row">
          <span class="entity-eyebrow">Managing Agent Profile</span>
          ${rateBadge(k?.repayment_rate)}
        </div>
        <h2>${esc(r.agent?.full_name || 'Unnamed agent')}</h2>
        <div class="entity-phone">${esc(r.agent?.phone || DASH)}</div>
        <div class="entity-meta">Territory: <strong>${esc(r.agent?.territory || 'Not assigned')}</strong></div>
      </div>
      <div class="entity-stats">
        <div class="entity-stat-pill">
          <div class="label">Assigned Tenants</div>
          <div class="val num">${num(k?.assigned_tenants)}</div>
          <div class="stat-sub">${num(k?.active_repaying)} active repaying</div>
        </div>
        <div class="entity-stat-pill">
          <div class="label">Repayment Rate</div>
          <div class="val num pct">${pct(k?.repayment_rate)}</div>
          <div class="stat-sub">${ugxShort(k?.collected_to_date)} to date</div>
        </div>
      </div>
    </div>`,
    kpiGrid(
      [
        { label: 'Assigned Tenants', value: num(k?.assigned_tenants) },
        { label: 'Active Repaying', value: num(k?.active_repaying) },
        { label: 'Rent Amount', value: ugx(k?.rent_total), variant: 'primary' },
        { label: 'Collected To Date', value: ugx(k?.collected_to_date), variant: 'success' },
        { label: 'Outstanding', value: ugx(k?.outstanding), variant: 'danger' },
        { label: 'Repayment Rate', value: pct(k?.repayment_rate), variant: 'success' },
      ],
      6,
    ),
    sectionTitle('Rent Repayment History', `Aggregated per period • ${rangeLabel(r.range)}`),
    `<div class="section-subtitle">Scheduled rent obligation against amounts actually collected, with the resulting shortfall per period.</div>`,
    chartBlock({
      canvasId: 'chart-agent-history',
      title: 'Repayment Trajectory — Expected vs Collected',
      subtitle: 'Fulfilment against obligation across the reporting window.',
      summaryCaption: 'Chart data summary — period repayment audit',
      head: `<tr><th>Period</th><th class="right">Expected</th><th class="right">Collected</th><th class="right">Shortfall</th><th class="right">Payments</th><th class="right">Rate</th></tr>`,
      rows: periods.map(
        (x) =>
          `<tr><td class="date">${esc(x.period)}</td><td class="right num currency">${ugx(x.expected)}</td><td class="right num currency tone-excellent">${ugx(
            x.collected,
          )}</td><td class="right num currency tone-critical">${ugx(x.shortfall)}</td><td class="right num">${num(
            x.payments,
          )}</td><td class="right num">${rateCell(x.rate)}</td></tr>`,
      ),
      foot: `<tr class="total-row"><td>Window total</td><td class="right num currency">${ugx(
        k?.expected_window,
      )}</td><td class="right num currency">${ugx(k?.collected_window)}</td><td class="right num currency">${ugx(
        n(k?.expected_window) - n(k?.collected_window),
      )}</td><td class="right num">${num(k?.payments_window)}</td><td class="right num pct">${pct(k?.window_rate)}</td></tr>`,
      colspan: 6,
    }),
    `<div class="observation-callout avoid-break"><strong>Window summary:</strong> ${num(
      k?.active_repaying,
    )} of ${num(k?.assigned_tenants)} assigned tenants were repaying. ${ugx(
      k?.collected_window,
    )} was collected against ${ugx(k?.expected_window)} expected across ${num(
      k?.payments_window,
    )} payments (${pct(k?.window_rate)}). Portfolio repayment to date stands at ${pct(k?.repayment_rate)}.</div>`,
  ].join('');

  const p2 = [
    docHeader({
      title: 'Tenant Collections Portfolio Overview',
      subtitle: 'Itemized Summary of All Managed Tenant Obligations',
      meta: [
        { label: 'Agent', value: r.agent?.full_name || DASH },
        { label: 'Phone', value: r.agent?.phone || DASH },
        { label: 'Tenants', value: `${num(tenants.length)} accounts` },
      ],
    }),
    sectionTitle('Tenant Rent Collection Summary', 'Master portfolio summary'),
    `<div class="section-subtitle">Collected is the amount taken inside the selected window; percentage is repayment progress to date.</div>`,
    table({
      head: `<tr><th style="width:24%">Tenant Name &amp; Contact</th><th class="right">Rent Amount</th><th class="right">Outstanding</th><th class="right">Repayment</th><th class="right">Collected (Window)</th><th class="right">Collected To Date</th><th class="right">Percentage</th><th>Latest Collection</th></tr>`,
      rows: tenants.map(
        (x) =>
          `<tr><td><div class="cell-strong">${esc(x.tenant_name || 'Unnamed tenant')}</div><div class="cell-sub font-mono">${esc(
            x.tenant_phone || DASH,
          )}</div></td><td class="right num currency">${ugx(x.rent_amount)}</td><td class="right num currency${
            n(x.outstanding) > 0 ? ' tone-critical' : ''
          }">${ugx(x.outstanding)}</td><td class="right num currency">${ugx(x.repayment)}</td><td class="right num currency tone-excellent">${ugx(
            x.collected,
          )}</td><td class="right num currency">${ugx(x.collected_to_date)}</td><td class="right num">${rateCell(
            x.percentage,
          )}</td><td><div class="date">${dayTime(x.last_collection_at)}</div><span class="doc-badge badge-${
            TIER_BADGE[rateTier(x.percentage)]
          }">${esc(x.status || DASH)}</span></td></tr>`,
      ),
      foot: `<tr class="total-row"><td>Totals · ${num(tenants.length)} tenants</td><td class="right num currency">${ugx(
        t.rent,
      )}</td><td class="right num currency">${ugx(t.out)}</td><td class="right num currency">${ugx(
        t.rep,
      )}</td><td class="right num currency">${ugx(t.col)}</td><td class="right num currency">${ugx(
        t.ctd,
      )}</td><td class="right num pct">${pct(k?.repayment_rate)}</td><td><span class="doc-badge badge-primary">Reconciled</span></td></tr>`,
      colspan: 8,
      emptyText: 'This agent had no tenant rent plans in the selected window.',
    }),
    `<div class="directive-box avoid-break">
      <div class="directive-title">Basis of preparation</div>
      <p>Expected figures are drawn from the daily eligibility snapshots that drive the daily collection gate. Collected figures are actual receipts recorded in agent collections for the window stated above. Percentages are repayment progress against the tenant's total Rent Plan obligation, not window fulfilment.</p>
      <div class="directive-signoff"><span>Report window: <strong>${esc(rangeLabel(r.range))}</strong></span><span>Reference: <strong>${esc(
        auditRef('AGR', r.range),
      )}</strong></span></div>
    </div>`,
  ].join('');

  // ---- Page 3: individual tenant bio + itemized collection ledgers --------
  // Only tenants with at least one receipt in the window get a ledger card;
  // listing 80+ empty cards would bury the ones that matter.
  const ledgerTenants = tenants.filter((x) => (x.history?.length ?? 0) > 0);
  const historyAvailable = tenants.some((x) => Array.isArray(x.history));

  const tenantCard = (x: AgentReport['tenants'][number]): string => {
    const t = rateTier(x.percentage);
    const rows = (x.history ?? []).map(
      (h) =>
        `<tr><td class="date" style="font-weight:600">${dayTime(h.at)}</td><td class="font-mono cell-sub">${esc(
          h.ref || DASH,
        )}</td><td class="right num currency">${ugx(h.expected)}</td><td class="right num currency tone-excellent" style="font-weight:700">${ugx(
          h.collected,
        )}</td><td class="right num currency${n(h.shortfall) > 0 ? ' tone-critical' : ''}">${ugx(
          h.shortfall,
        )}</td><td>${esc(channelLabel(h.channel))}</td><td><span class="doc-badge badge-${
          /partial/i.test(h.status || '') ? 'warn' : 'pass'
        }">${esc(h.status || DASH)}</span></td></tr>`,
    );

    return `<div class="tenant-card-block avoid-break">
  <div class="tenant-card-header">
    <div class="tenant-name-title"><span>${esc(x.tenant_name || 'Unnamed tenant')}</span></div>
    <div style="display:flex;align-items:center;gap:8px">
      <span class="font-mono" style="font-size:9px;font-weight:700">${esc(x.tenant_phone || DASH)}</span>
      <span class="doc-badge badge-${TIER_BADGE[t]}">${esc(x.status || TIER_LABEL[t])}</span>
    </div>
  </div>
  <div class="tenant-bio-grid">
    <div class="bio-item"><span class="bio-lbl">National ID (NIN)</span><span class="bio-val font-mono">${esc(
      x.national_id || DASH,
    )}</span></div>
    <div class="bio-item"><span class="bio-lbl">Location</span><span class="bio-val">${esc(
      x.location || DASH,
    )}</span></div>
    <div class="bio-item"><span class="bio-lbl">House Type</span><span class="bio-val">${esc(
      x.house_type || DASH,
    )}</span></div>
    <div class="bio-item"><span class="bio-lbl">Occupation</span><span class="bio-val">${esc(
      x.occupation || DASH,
    )}</span></div>
    <div class="bio-item"><span class="bio-lbl">Daily Installment</span><span class="bio-val num currency">${
      x.daily_repayment == null ? DASH : `${ugx(x.daily_repayment)} / day`
    }</span></div>
  </div>
  <div class="tenant-kpi-bar">
    <div class="tenant-kpi-pill"><div class="t-lbl">Rent Amount</div><div class="t-val num currency">${ugx(
      x.rent_amount,
    )}</div></div>
    <div class="tenant-kpi-pill"><div class="t-lbl">Total Repayment</div><div class="t-val num currency">${ugx(
      x.repayment,
    )}</div></div>
    <div class="tenant-kpi-pill"><div class="t-lbl">Collected To Date</div><div class="t-val num currency tone-excellent">${ugx(
      x.collected_to_date,
    )}</div></div>
    <div class="tenant-kpi-pill"><div class="t-lbl">Outstanding</div><div class="t-val num currency${
      n(x.outstanding) > 0 ? ' tone-critical' : ''
    }">${ugx(x.outstanding)}</div></div>
    <div class="tenant-kpi-pill"><div class="t-lbl">Repayment Rate</div><div class="t-val num pct ${
      TIER_TONE[t]
    }">${pct(x.percentage)}</div></div>
  </div>
  <div style="padding:6px 12px 8px 12px">
    <div class="chart-summary-cap" style="margin-top:0">Itemized collections — ${esc(
      rangeLabel(r.range),
    )}${x.history_truncated ? ' (newest 100 shown)' : ''}</div>
    ${table({
      head: `<tr><th style="width:18%">Date &amp; Time</th><th style="width:16%">Receipt / Ref</th><th class="right">Expected</th><th class="right">Collected</th><th class="right">Shortfall</th><th>Channel</th><th>Status</th></tr>`,
      rows,
      foot: `<tr class="total-row"><td colspan="2">Window subtotal · ${num(
        x.payments,
      )} payments</td><td class="right num currency">${ugx(
        (x.history ?? []).reduce((a, h) => a + n(h.expected), 0),
      )}</td><td class="right num currency">${ugx(x.collected)}</td><td class="right num currency">${ugx(
        (x.history ?? []).reduce((a, h) => a + n(h.shortfall), 0),
      )}</td><td colspan="2"></td></tr>`,
      colspan: 7,
    })}
  </div>
</div>`;
  };

  const p3 = [
    docHeader({
      title: 'Individual Tenant Collection History Ledgers',
      subtitle: 'Tenant Bio Profiles, Rent Obligations & Itemized Receipts',
      meta: [
        { label: 'Agent', value: r.agent?.full_name || DASH },
        { label: 'Ledgers Shown', value: `${num(ledgerTenants.length)} of ${num(tenants.length)} tenants` },
        { label: 'Audit Scope', value: rangeLabel(r.range) },
      ],
    }),
    sectionTitle('Tenant Collection Ledgers & Payment Histories', 'Tenants with receipts in this window'),
    `<div class="section-subtitle">Each card carries the tenant's bio, their Rent Plan position, and every receipt recorded in the selected window. Shortfall is the amount short of that day's expected installment.</div>`,
    !historyAvailable
      ? `<div class="observation-callout"><strong>Itemized ledgers unavailable.</strong> This report was produced by a server build that does not yet return per-tenant receipt history. Pages 1 and 2 are unaffected. Apply migration <span class="font-mono">20260908210000_agent_ops_report_agent_tenant_ledgers.sql</span> to populate this section.</div>`
      : ledgerTenants.length === 0
        ? `<div class="observation-callout">No tenant recorded a receipt in this window, so there are no itemized ledgers to show. Tenant positions are on page 2.</div>`
        : `<div class="tenant-history-section">${ledgerTenants.map(tenantCard).join('')}</div>`,
  ].join('');

  return shell({
    title: `Welile — Agent Report — ${r.agent?.full_name || 'Agent'}`,
    pages: [
      page(p1, 'Agent Report | Page 1 of 3'),
      page(p2, 'Agent Report | Page 2 of 3'),
      page(p3, 'Agent Report | Page 3 of 3'),
    ],
    charts: [
      {
        canvas: 'chart-agent-history',
        type: 'line',
        labels: periods.map((x) => x.period),
        datasets: [
          { ...SERIES.expected, data: periods.map((x) => toM(x.expected)) },
          { ...SERIES.collected, data: periods.map((x) => toM(x.collected)) },
        ],
      },
    ],
  });
}

/* --------------------------------------------- 2. Rent collections report */

export function buildRentCollectionsReportHtml(r: RentCollectionsReport): string {
  const k = r.kpis;
  const rows = r.rows ?? [];

  const t = rows.reduce(
    (a, x) => ({
      tenants: a.tenants + n(x.repaying_tenants),
      exp: a.exp + n(x.expected),
      col: a.col + n(x.collected),
      pay: a.pay + n(x.payments),
      paid: a.paid + n(x.paid_tenants),
    }),
    { tenants: 0, exp: 0, col: 0, pay: 0, paid: 0 },
  );

  // Status histogram — one pass over the rows already in hand, bucketed by the
  // SERVER's own status, so the doughnut, the summary table and the per-row
  // badges can never disagree. Empty buckets are dropped so the chart is not
  // padded with zero slices.
  const tiers = rows.reduce<Record<Tier, number>>(
    (a, x) => {
      a[tierOfStatus(x.status, x.rate)] += 1;
      return a;
    },
    { excellent: 0, ontrack: 0, fair: 0, behind: 0, silent: 0, unscheduled: 0 },
  );
  const tierRows = TIER_ORDER.filter((t) => tiers[t] > 0).map((t) => ({
    tier: t,
    label: `${TIER_LABEL[t]} (${TIER_RANGE[t]})`,
    count: tiers[t],
  }));

  const p1 = [
    docHeader({
      title: 'Rent Collections Comprehensive Report',
      subtitle: 'Active Repaying Tenants — Aggregated Collection Performance',
      meta: [
        { label: 'Date Window', value: rangeLabel(r.range) },
        { label: 'Report Scope', value: 'Active repaying tenants only' },
        { label: 'Audit Ref ID', value: auditRef('RCR', r.range) },
        { label: 'Collection Rate', value: pct(k?.collection_rate), tone: rateTier(k?.collection_rate) === 'behind' ? 'bad' : 'ok' },
      ],
    }),
    kpiGrid(
      [
        // Both counts are window-scoped, NOT the platform-wide agent count.
        // total_agents = agents carrying a repaying tenant (an expected amount)
        // on at least one day in the window; active_agents = those who actually
        // banked a collection inside it. An agent with tenants but no receipt in
        // the window is counted in the first and not the second.
        { label: 'Agents With Repaying Tenants', value: num(k?.total_agents), sub: 'Expected an amount in this window' },
        {
          label: 'Agents Who Collected',
          value: num(k?.active_agents),
          sub: `${pct(n(k?.total_agents) ? (n(k?.active_agents) / n(k?.total_agents)) * 100 : 0)} of them, in this window`,
          variant: 'primary',
        },
        { label: 'Expected', value: ugx(k?.expected), sub: 'Window obligation' },
        { label: 'Collected', value: ugx(k?.collected), sub: 'Recovered amount', variant: 'success' },
        { label: 'Collection Rate', value: pct(k?.collection_rate), sub: 'Network fulfilment', variant: 'success' },
      ],
      5,
    ),
    sectionTitle('Daily Active Agent Collections Breakdown', 'Aggregated for the selected range'),
    `<div class="section-subtitle">Expected and collected figures are aggregated per agent over the whole selected window.</div>`,
    table({
      head: `<tr><th style="width:4%">#</th><th style="width:20%">Agent Name</th><th style="width:15%">Agent Phone</th><th class="right">Repaying Tenants</th><th class="right">Expected (UGX)</th><th class="right">Collected (UGX)</th><th class="right">Rate</th><th class="right">Paid</th><th>Status</th></tr>`,
      rows: rows.map(
        (x, i) =>
          `<tr><td class="num font-mono" style="color:var(--text-muted);font-weight:700">${i + 1}</td><td><div class="cell-strong">${esc(
            x.full_name || 'Unnamed agent',
          )}</div></td><td class="font-mono cell-sub">${esc(x.phone || DASH)}</td><td class="right num" style="font-weight:700">${num(
            x.repaying_tenants,
          )}</td><td class="right num currency">${ugx(x.expected)}</td><td class="right num currency tone-excellent">${ugx(
            x.collected,
          )}</td><td class="right num">${rateCell(x.rate, x.status)}</td><td class="right num">${num(
            x.paid_tenants,
          )}<span class="cell-sub" style="display:block">${num(x.payments)} txns</span></td><td>${statusBadge(x.status, x.rate)}</td></tr>`,
      ),
      foot: `<tr class="total-row"><td colspan="3">Totals · ${num(rows.length)} agents listed</td><td class="right num">${num(
        t.tenants,
      )}</td><td class="right num currency">${ugx(t.exp)}</td><td class="right num currency">${ugx(
        t.col,
      )}</td><td class="right num pct">${pct(t.exp > 0 ? (t.col / t.exp) * 100 : null)}</td><td class="right num">${num(
        t.paid,
      )}<span class="cell-sub" style="display:block">${num(t.pay)} txns</span></td><td>${rateBadge(
        t.exp > 0 ? (t.col / t.exp) * 100 : null,
      )}</td></tr>`,
      colspan: 9,
      emptyText: 'No agent collections were recorded in the selected window.',
    }),
    `<div class="observation-callout avoid-break"><strong>Collections highlight:</strong> ${num(
      k?.active_agents,
    )} of ${num(k?.total_agents)} agents collected in this window, covering ${num(
      k?.repaying_tenants,
    )} repaying tenants. Fulfilment reached ${pct(k?.collection_rate)} — ${ugx(k?.collected)} collected against ${ugx(
      k?.expected,
    )} expected.</div>`,
  ].join('');

  const p2 = [
    docHeader({
      title: 'Collections Analytics & Performance Distribution',
      subtitle: 'Agent Fulfilment Tiers Across the Reporting Window',
      meta: [
        { label: 'Date Window', value: rangeLabel(r.range) },
        { label: 'Agents Listed', value: num(rows.length) },
        { label: 'Shortfall', value: ugx(n(k?.expected) - n(k?.collected)), tone: 'warn' },
      ],
    }),
    `<div class="chart-grid-2col">
      ${chartBlock({
        canvasId: 'chart-tier-distribution',
        title: 'Agent Performance Tier Distribution',
        subtitle: 'Share of listed agents by collection fulfilment rate.',
        summaryCaption: 'Chart data summary — tier distribution',
        head: `<tr><th>Performance Tier</th><th class="right">Agents</th><th class="right">% Share</th></tr>`,
        rows: tierRows.map(
          (x) =>
            `<tr><td><span class="doc-badge badge-${TIER_BADGE[x.tier]}">${esc(x.label)}</span></td><td class="right num">${num(
              x.count,
            )}</td><td class="right num pct">${pct(rows.length ? (x.count / rows.length) * 100 : 0)}</td></tr>`,
        ),
        foot: `<tr class="total-row"><td>Total listed</td><td class="right num">${num(
          rows.length,
        )}</td><td class="right num pct">${rows.length ? '100.0%' : DASH}</td></tr>`,
        colspan: 3,
      })}
      ${chartBlock({
        canvasId: 'chart-top-agents',
        title: 'Top Collecting Agents (UGX Millions)',
        subtitle: 'Highest collected volume in the window.',
        summaryCaption: 'Chart data summary — top collectors',
        head: `<tr><th>Agent</th><th class="right">Expected</th><th class="right">Collected</th><th class="right">Rate</th></tr>`,
        rows: rows
          .slice()
          .sort((a, b) => n(b.collected) - n(a.collected))
          .slice(0, 8)
          .map(
            (x) =>
              `<tr><td class="cell-strong">${esc(x.full_name || 'Unnamed')}</td><td class="right num">${ugxShort(
                x.expected,
              )}</td><td class="right num tone-excellent">${ugxShort(x.collected)}</td><td class="right num">${rateCell(
                x.rate,
              )}</td></tr>`,
          ),
        colspan: 4,
      })}
    </div>`,
    `<div class="directive-box avoid-break">
      <div class="directive-title">Reconciliation basis</div>
      <p>Expected is the sum of each agent's frozen daily eligibility snapshots for every day in the window (today's live figure is used only for the current day, and only when no snapshot exists yet). Collected is the sum of agent collection receipts whose Africa/Kampala date falls in the window. Both bounds are inclusive.</p>
      <p style="margin-top:4px"><strong>Agent counts are scoped to this window and are not the platform-wide agent total.</strong> "Agents with repaying tenants" counts agents carrying at least one repaying tenant on at least one day in the window; "agents who collected" counts those who banked a receipt inside it. An agent who holds tenants but took nothing in the window appears in the first figure only.</p>
      <p style="margin-top:4px">Status is taken from the collections engine, not recomputed here: <strong>Excellent</strong> ≥ 100%, <strong>On track</strong> 75–99%, <strong>Fair</strong> 50–74%, <strong>Behind</strong> below 50%, <strong>Silent</strong> where nothing was collected, and <strong>Unscheduled</strong> where an agent collected with no expected amount for the window.</p>
      <div class="directive-signoff"><span>Window: <strong>${esc(rangeLabel(r.range))}</strong></span><span>Reference: <strong>${esc(
        auditRef('RCR', r.range),
      )}</strong></span></div>
    </div>`,
  ].join('');

  const top = rows.slice().sort((a, b) => n(b.collected) - n(a.collected)).slice(0, 8);

  return shell({
    title: `Welile — Rent Collections — ${r.range?.from} to ${r.range?.to}`,
    pages: [page(p1, 'Rent Collections Report | Page 1 of 2'), page(p2, 'Rent Collections Report | Page 2 of 2')],
    charts: [
      {
        canvas: 'chart-tier-distribution',
        type: 'doughnut',
        money: false,
        labels: tierRows.map((x) => x.label),
        datasets: [
          {
            data: tierRows.map((x) => x.count),
            backgroundColor: tierRows.map((x) => TIER_COLOR[x.tier]),
            borderWidth: 2,
            borderColor: '#FFFFFF',
          },
        ],
      },
      {
        canvas: 'chart-top-agents',
        type: 'bar',
        labels: top.map((x) => (x.full_name || 'Unnamed').slice(0, 18)),
        datasets: [
          { label: 'Expected', data: top.map((x) => toM(x.expected)), backgroundColor: '#CBD5E1', borderRadius: 3 },
          { label: 'Collected', data: top.map((x) => toM(x.collected)), backgroundColor: '#15803D', borderRadius: 3 },
        ],
      },
    ],
  });
}

/* ---------------------------------------------------- 3. Advances report */

export function buildAdvancesReportHtml(r: AdvancesReport): string {
  const k = r.kpis;
  const rows = r.rows ?? [];
  const stages = r.stages ?? [];
  const stageTotal = stages.reduce((a, s) => ({ c: a.c + n(s.count), v: a.v + n(s.value) }), { c: 0, v: 0 });

  const t = rows.reduce(
    (a, x) => ({
      disb: a.disb + n(x.disbursed),
      fee: a.fee + n(x.access_fee),
      rep: a.rep + n(x.repaid),
      out: a.out + n(x.outstanding),
      due: a.due + n(x.overdue),
    }),
    { disb: 0, fee: 0, rep: 0, out: 0, due: 0 },
  );

  const p1 = [
    docHeader({
      title: 'Agent Advances & Float Recovery Report',
      subtitle: 'Advance Capital Deployment, Float Recovery & Overdue Risk Audit',
      meta: [
        { label: 'Audit Period', value: rangeLabel(r.range) },
        { label: 'Ledger Focus', value: 'Agent float & short-term advances' },
        { label: 'Audit Ref ID', value: auditRef('ADV', r.range) },
        { label: 'Recovery Rate', value: pct(k?.recovery_rate), tone: rateTier(k?.recovery_rate) === 'behind' ? 'bad' : 'ok' },
      ],
    }),
    kpiGrid(
      [
        { label: 'Advance Volume', value: ugx(k?.volume), variant: 'primary' },
        { label: 'Advances Issued', value: num(k?.issued_count) },
        { label: 'Agents With Advances', value: num(k?.agents) },
        { label: 'Pending Applications', value: num(k?.pending_apps) },
        { label: 'Repaid', value: ugx(k?.repaid), variant: 'success' },
        { label: 'Outstanding', value: ugx(k?.outstanding), variant: 'warning' },
        { label: 'Arrears', value: ugx(k?.arrears), variant: 'danger' },
        { label: 'Recovery Rate', value: pct(k?.recovery_rate), variant: 'success' },
      ],
      4,
    ),
    sectionTitle('Advance Portfolio Status Breakdown', 'Distribution by pipeline stage'),
    table({
      head: `<tr><th>Pipeline Stage</th><th class="right">Advances</th><th class="right">% of Count</th><th class="right">Value (UGX)</th><th class="right">% of Volume</th></tr>`,
      rows: stages.map(
        (s) =>
          `<tr><td class="cell-strong">${esc(s.stage)}</td><td class="right num">${num(s.count)}</td><td class="right num pct">${pct(
            stageTotal.c ? (n(s.count) / stageTotal.c) * 100 : 0,
          )}</td><td class="right num currency">${ugx(s.value)}</td><td class="right num pct">${pct(
            stageTotal.v ? (n(s.value) / stageTotal.v) * 100 : 0,
          )}</td></tr>`,
      ),
      foot: `<tr class="total-row"><td>Total advance pipeline</td><td class="right num">${num(
        stageTotal.c,
      )}</td><td class="right num pct">${stageTotal.c ? '100.0%' : DASH}</td><td class="right num currency">${ugx(
        stageTotal.v,
      )}</td><td class="right num pct">${stageTotal.v ? '100.0%' : DASH}</td></tr>`,
      colspan: 5,
      emptyText: 'No advances were issued in the selected window.',
    }),
    chartBlock({
      canvasId: 'chart-advance-recovery',
      title: 'Advance Recovery — Repaid vs Outstanding vs Arrears',
      subtitle: 'Capital position across the advances issued in this window.',
      summaryCaption: 'Chart data summary — recovery position',
      head: `<tr><th>Position</th><th class="right">Amount (UGX)</th><th class="right">% of Exposure</th></tr>`,
      rows: (() => {
        const exposure = n(k?.repaid) + n(k?.outstanding);
        return [
          { label: 'Repaid', v: n(k?.repaid), tone: 'tone-excellent' },
          { label: 'Outstanding', v: n(k?.outstanding), tone: 'tone-attention' },
          { label: 'Arrears (overdue)', v: n(k?.arrears), tone: 'tone-critical' },
        ].map(
          (x) =>
            `<tr><td class="cell-strong">${esc(x.label)}</td><td class="right num currency ${x.tone}">${ugx(
              x.v,
            )}</td><td class="right num pct">${pct(exposure ? (x.v / exposure) * 100 : 0)}</td></tr>`,
        );
      })(),
      foot: `<tr class="total-row"><td>Total exposure</td><td class="right num currency">${ugx(
        n(k?.repaid) + n(k?.outstanding),
      )}</td><td class="right num pct">${pct(k?.recovery_rate)} recovered</td></tr>`,
      colspan: 3,
    }),
    `<div class="observation-callout avoid-break"><strong>Portfolio observation:</strong> ${num(
      k?.issued_count,
    )} advances totalling ${ugx(k?.volume)} were issued to ${num(k?.agents)} agents. Recovery stands at ${pct(
      k?.recovery_rate,
    )} with ${ugx(k?.outstanding)} outstanding, of which ${ugx(
      k?.arrears,
    )} is overdue. ${num(k?.pending_apps)} applications await review.</div>`,
  ].join('');

  const p2 = [
    docHeader({
      title: 'Agent Advance Performance Ledger',
      subtitle: 'Individual Disbursals, Recovery Rates & Overdue Accounts',
      meta: [
        { label: 'Advance Accounts', value: `${num(rows.length)} listed` },
        { label: 'Arrears', value: ugx(t.due), tone: t.due > 0 ? 'bad' : 'ok' },
        { label: 'Settlement Mode', value: 'Scheduled auto-deduction' },
      ],
    }),
    sectionTitle('Agent Advance Master Ledger', 'Detailed audit of advance accounts'),
    table({
      head: `<tr><th style="width:20%">Agent Name &amp; Phone</th><th class="right">Disbursed</th><th class="right">Access Fee</th><th class="right">Repaid</th><th class="right">Outstanding</th><th class="right">Overdue</th><th class="right">Recovery</th><th>Issued</th><th>Status</th></tr>`,
      rows: rows.map(
        (x) =>
          `<tr${n(x.overdue) > 0 ? ' class="highlight-danger"' : ''}><td><div class="cell-strong">${esc(
            x.full_name || 'Unnamed agent',
          )}</div><div class="cell-sub font-mono">${esc(x.phone || DASH)}</div></td><td class="right num currency">${ugx(
            x.disbursed,
          )}</td><td class="right num currency">${ugx(x.access_fee)}</td><td class="right num currency tone-excellent">${ugx(
            x.repaid,
          )}</td><td class="right num currency">${ugx(x.outstanding)}</td><td class="right num currency${
            n(x.overdue) > 0 ? ' tone-critical' : ''
          }" style="font-weight:${n(x.overdue) > 0 ? 800 : 400}">${ugx(x.overdue)}</td><td class="right num">${rateCell(
            x.recovery_rate,
          )}</td><td><div class="date">${day(x.issued_at)}</div><div class="cell-sub">${esc(
            x.frequency || DASH,
          )} · ${ugxShort(x.installment)}</div></td><td><span class="doc-badge badge-${
            n(x.overdue) > 0 ? 'fail' : 'pass'
          }">${esc(x.status || DASH)}</span></td></tr>`,
      ),
      foot: `<tr class="total-row"><td>Totals · ${num(rows.length)} accounts</td><td class="right num currency">${ugx(
        t.disb,
      )}</td><td class="right num currency">${ugx(t.fee)}</td><td class="right num currency">${ugx(
        t.rep,
      )}</td><td class="right num currency">${ugx(t.out)}</td><td class="right num currency">${ugx(
        t.due,
      )}</td><td class="right num pct">${pct(t.disb > 0 ? (t.rep / t.disb) * 100 : null)}</td><td colspan="2"><span class="doc-badge badge-info">Reconciled</span></td></tr>`,
      colspan: 9,
      emptyText: 'No advance accounts in the selected window.',
    }),
    `<div class="directive-box avoid-break">
      <div class="directive-title">Welile float &amp; advance accountability directive</div>
      <p>All float advanced remains the property of Welile Technologies Limited and is held strictly in trust. Agents are accountable for the total advance volume: float balance plus verified tenant payouts must equal the advance disbursed. Overdue balances are subject to automatic float freezes and guarantor recovery. Access fee is the disclosed cost of the advance, not interest.</p>
      <div class="directive-signoff"><span>Head of Agent Operations</span><span>Credit Risk Officer</span><span>Audit window: <strong>${esc(
        rangeLabel(r.range),
      )}</strong></span></div>
    </div>`,
  ].join('');

  return shell({
    title: `Welile — Agent Advances — ${r.range?.from} to ${r.range?.to}`,
    pages: [page(p1, 'Agent Advances Report | Page 1 of 2'), page(p2, 'Agent Advances Report | Page 2 of 2')],
    charts: [
      {
        canvas: 'chart-advance-recovery',
        type: 'bar',
        labels: ['Repaid', 'Outstanding', 'Arrears'],
        datasets: [
          {
            label: 'Position (M UGX)',
            data: [toM(k?.repaid), toM(k?.outstanding), toM(k?.arrears)],
            backgroundColor: ['#15803D', '#B45309', '#B91C1C'],
            borderRadius: 3,
          },
        ],
      },
    ],
  });
}

/* --------------------------------------------- 4. Team collections report */

export function buildTeamCollectionsReportHtml(r: TeamCollectionsReport): string {
  const k = r.kpis;
  const rows = r.rows ?? [];
  const members = rows.filter((x) => !x.is_leader);

  const t = rows.reduce(
    (a, x) => ({
      tenants: a.tenants + n(x.tenants),
      exp: a.exp + n(x.expected),
      col: a.col + n(x.collected),
      pay: a.pay + n(x.payments),
    }),
    { tenants: 0, exp: 0, col: 0, pay: 0 },
  );

  const rankLabel = k?.rank != null ? `#${num(k.rank)}${k?.total_teams ? ` of ${num(k.total_teams)}` : ''}` : DASH;
  const rankBadge = k?.rank == null ? 'silver' : k.rank <= 3 ? 'gold' : k.rank <= 20 ? 'silver' : 'bronze';

  const p1 = [
    docHeader({
      title: 'Team Collections & Sub-Agent Network Report',
      subtitle: 'Team Hierarchy, Sub-Agent Group Contribution & Target Fulfilment',
      meta: [
        { label: 'Report Window', value: rangeLabel(r.range) },
        { label: 'Hierarchy Tier', value: 'Team leader & sub-agent grid' },
        { label: 'Audit Ref ID', value: auditRef('TCR', r.range) },
        { label: 'Group Rate', value: pct(k?.rate), tone: rateTier(k?.rate) === 'behind' ? 'bad' : 'ok' },
      ],
    }),
    `<div class="entity-card">
      <div class="entity-info">
        <div class="entity-header-row">
          <span class="entity-eyebrow">Team Leader In Charge</span>
          <span class="doc-badge badge-${rankBadge}">Rank ${esc(rankLabel)}</span>
        </div>
        <h2>${esc(r.leader?.full_name || 'Unnamed leader')}</h2>
        <div class="entity-phone">${esc(r.leader?.phone || DASH)}</div>
        <div class="entity-meta">Sub-agent network of <strong>${num(k?.sub_agents)}</strong> managing <strong>${num(
          k?.tenants,
        )}</strong> tenants</div>
      </div>
      <div class="entity-stats">
        <div class="entity-stat-pill">
          <div class="label">Sub-Agents</div>
          <div class="val num">${num(k?.sub_agents)}</div>
          <div class="stat-sub">${num(k?.tenants)} tenants managed</div>
        </div>
        <div class="entity-stat-pill">
          <div class="label">Period Performance</div>
          <div class="val num pct">${pct(k?.rate)}</div>
          <div class="stat-sub">${ugxShort(k?.collected)} / ${ugxShort(k?.expected)}</div>
        </div>
      </div>
    </div>`,
    kpiGrid(
      [
        { label: 'Team Leader', value: r.leader?.full_name || DASH },
        { label: 'Total Sub-Agents', value: num(k?.sub_agents) },
        { label: 'Total Collected', value: ugx(k?.collected), variant: 'success' },
        { label: 'Expected Target', value: ugx(k?.expected), variant: 'primary' },
        { label: 'Rate / Rank', value: `${pct(k?.rate)} (${rankLabel})`, variant: 'success' },
      ],
      5,
    ),
    sectionTitle('Sub-Agent Network Performance & Group Contribution', `Collections window: ${rangeLabel(r.range)}`),
    `<div class="section-subtitle">Individual tenant volumes, collected amounts, and each member's share of the group's expected target.</div>`,
    table({
      head: `<tr><th style="width:24%">Agent Name &amp; Phone</th><th class="right">Tenants</th><th class="right">Expected (UGX)</th><th class="right">Collected (UGX)</th><th class="right">Rate</th><th class="right">% of Group Expected</th><th>Collections in Window</th><th>Role</th></tr>`,
      rows: rows.map(
        (x) =>
          `<tr><td><div class="cell-strong">${esc(x.full_name || 'Unnamed agent')}</div><div class="cell-sub font-mono">${esc(
            x.phone || DASH,
          )}</div></td><td class="right num" style="font-weight:700">${num(x.tenants)}</td><td class="right num currency">${ugx(
            x.expected,
          )}</td><td class="right num currency tone-excellent" style="font-weight:800">${ugx(
            x.collected,
          )}</td><td class="right num">${rateCell(x.rate)}</td><td class="right num pct" style="color:var(--primary);font-weight:800">${pct(
            x.share_of_group_expected,
          )}</td><td><div>${num(x.payments)} payments</div><div class="cell-sub">${dayTime(
            x.last_collection_at,
          )}</div></td><td><span class="doc-badge badge-${x.is_leader ? 'primary' : 'pass'}">${
            x.is_leader ? 'Team Leader' : 'Sub-Agent'
          }</span></td></tr>`,
      ),
      foot: `<tr class="total-row"><td>Overall totals · ${num(rows.length)} members (${num(
        members.length,
      )} sub-agents)</td><td class="right num">${num(t.tenants)}</td><td class="right num currency">${ugx(
        t.exp,
      )}</td><td class="right num currency">${ugx(t.col)}</td><td class="right num pct">${pct(
        t.exp > 0 ? (t.col / t.exp) * 100 : null,
      )}</td><td class="right num pct">${t.exp > 0 ? '100.0%' : DASH}</td><td>${num(
        t.pay,
      )} payments</td><td><span class="doc-badge badge-info">Reconciled</span></td></tr>`,
      colspan: 8,
      emptyText: 'This team recorded no collections in the selected window.',
    }),
    `<div class="observation-callout avoid-break"><strong>Team supervisory note:</strong> ${esc(
      r.leader?.full_name || 'This leader',
    )} oversees ${num(k?.sub_agents)} sub-agents managing ${num(k?.tenants)} tenants. The group collected ${ugx(
      k?.collected,
    )} against ${ugx(k?.expected)} expected (${pct(k?.rate)}), ranking ${esc(rankLabel)}.</div>`,
  ].join('');

  const top = rows
    .slice()
    .sort((a, b) => n(b.collected) - n(a.collected))
    .slice(0, 5);

  const p2 = [
    docHeader({
      title: 'Team Contribution Analytics & Ranking',
      subtitle: 'Breakdown of Sub-Agent Contribution & Target Fulfilment',
      meta: [
        { label: 'Team Leader', value: r.leader?.full_name || DASH },
        { label: 'Overall Expected', value: ugx(k?.expected) },
        { label: 'Overall Collected', value: ugx(k?.collected), tone: 'ok' },
      ],
    }),
    `<div class="chart-grid-2col wide-left">
      ${chartBlock({
        canvasId: 'chart-team-share',
        title: 'Share of Total Team Collections',
        subtitle: 'Proportional contribution across the top members.',
        summaryCaption: 'Chart data summary — contribution share',
        head: `<tr><th>Member</th><th class="right">Collected</th><th class="right">% Group Collected</th></tr>`,
        rows: top.map(
          (x) =>
            `<tr><td class="cell-strong">${esc(x.full_name || 'Unnamed')}</td><td class="right num tone-excellent">${ugxShort(
              x.collected,
            )}</td><td class="right num pct">${pct(t.col > 0 ? (n(x.collected) / t.col) * 100 : 0)}</td></tr>`,
        ),
        foot: `<tr class="total-row"><td>Group total</td><td class="right num currency">${ugx(
          t.col,
        )}</td><td class="right num pct">${t.col > 0 ? '100.0%' : DASH}</td></tr>`,
        colspan: 3,
      })}
      ${chartBlock({
        canvasId: 'chart-team-target',
        title: 'Target vs Collected (Top Members)',
        subtitle: 'Fulfilment against each member’s expected obligation.',
        summaryCaption: 'Chart data summary — target fulfilment',
        head: `<tr><th>Member</th><th class="right">Expected</th><th class="right">Collected</th><th class="right">Rate</th></tr>`,
        rows: top.map(
          (x) =>
            `<tr><td class="cell-strong">${esc(x.full_name || 'Unnamed')}</td><td class="right num">${ugxShort(
              x.expected,
            )}</td><td class="right num tone-excellent">${ugxShort(x.collected)}</td><td class="right num">${rateCell(
              x.rate,
            )}</td></tr>`,
        ),
        colspan: 4,
      })}
    </div>`,
    `<div class="directive-box avoid-break">
      <div class="directive-title">Team leader verification</div>
      <p>Tenant counts, collections and sub-agent contributions above are reconciled receipts for the stated window. Expected is aggregated from the daily eligibility snapshots for each member's active Rent Plans; share of group expected is each member's collected amount measured against the group's total expected target.</p>
      <div class="directive-signoff"><span>${esc(
        r.leader?.full_name || 'Team Leader',
      )} • Team Leader</span><span>Head of Field Agent Network</span><span>Window: <strong>${esc(
        rangeLabel(r.range),
      )}</strong></span></div>
    </div>`,
  ].join('');

  return shell({
    title: `Welile — Team Collections — ${r.leader?.full_name || 'Team'}`,
    pages: [page(p1, 'Team Collections Report | Page 1 of 2'), page(p2, 'Team Collections Report | Page 2 of 2')],
    charts: [
      {
        canvas: 'chart-team-share',
        type: 'doughnut',
        labels: top.map((x) => (x.full_name || 'Unnamed').slice(0, 18)),
        datasets: [
          {
            data: top.map((x) => toM(x.collected)),
            backgroundColor: ['#7B19D4', '#9333EA', '#A855F7', '#C084FC', '#E9D5FF'],
            borderWidth: 2,
            borderColor: '#FFFFFF',
          },
        ],
      },
      {
        canvas: 'chart-team-target',
        type: 'bar',
        labels: top.map((x) => (x.full_name || 'Unnamed').slice(0, 18)),
        datasets: [
          { label: 'Expected', data: top.map((x) => toM(x.expected)), backgroundColor: '#CBD5E1', borderRadius: 3 },
          { label: 'Collected', data: top.map((x) => toM(x.collected)), backgroundColor: '#15803D', borderRadius: 3 },
        ],
      },
    ],
  });
}

/* ------------------------------------- 5. Products & services report */

export function buildProductsReportHtml(r: ProductsReport): string {
  const k = r.kpis;
  const rows = r.rows ?? [];

  const t = rows.reduce(
    (a, x) => ({
      qty: a.qty + n(x.quantity),
      val: a.val + n(x.value),
      rec: a.rec + n(x.recovered),
      out: a.out + n(x.outstanding),
    }),
    { qty: 0, val: 0, rec: 0, out: 0 },
  );

  const p1 = [
    docHeader({
      title: 'Agent Products & Services Report',
      subtitle: 'Product Issuance, Recovery & Outstanding Exposure',
      meta: [
        { label: 'Report Window', value: rangeLabel(r.range) },
        { label: 'Scope', value: 'Agent product & service sales' },
        { label: 'Audit Ref ID', value: auditRef('APS', r.range) },
        { label: 'Recovery Rate', value: pct(k?.recovery_rate), tone: rateTier(k?.recovery_rate) === 'behind' ? 'bad' : 'ok' },
      ],
    }),
    kpiGrid(
      [
        { label: 'Applications', value: num(k?.applications) },
        { label: 'Approved', value: num(k?.approved), variant: 'success' },
        { label: 'Pending', value: num(k?.pending), variant: 'warning' },
        { label: 'Value Issued', value: ugx(k?.value_issued), variant: 'primary' },
        { label: 'Recovered', value: ugx(k?.recovered), variant: 'success' },
        { label: 'Recovery Rate', value: pct(k?.recovery_rate), variant: 'success' },
      ],
      6,
    ),
    sectionTitle('Product & Service Sales Ledger', 'Itemized issuance and recovery'),
    table({
      head: `<tr><th style="width:20%">Agent</th><th>Product</th><th>Category</th><th class="right">Qty</th><th class="right">Value (UGX)</th><th class="right">Recovered</th><th class="right">Outstanding</th><th>Plan</th><th>Date</th><th>Status</th></tr>`,
      rows: rows.map(
        (x) =>
          `<tr${n(x.outstanding) > 0 ? '' : ''}><td><div class="cell-strong">${esc(
            x.full_name || 'Unnamed agent',
          )}</div><div class="cell-sub font-mono">${esc(x.phone || DASH)}</div></td><td>${esc(
            x.product || DASH,
          )}</td><td>${esc(x.category || DASH)}</td><td class="right num">${num(
            x.quantity,
          )}</td><td class="right num currency">${ugx(x.value)}</td><td class="right num currency tone-excellent">${ugx(
            x.recovered,
          )}</td><td class="right num currency${n(x.outstanding) > 0 ? ' tone-critical' : ''}">${ugx(
            x.outstanding,
          )}</td><td class="cell-sub">${esc(x.payment_plan || DASH)}</td><td class="date">${day(
            x.date,
          )}</td><td><span class="doc-badge badge-${
            /approv|complet|settl|paid/i.test(x.status || '') ? 'pass' : /pend|review/i.test(x.status || '') ? 'warn' : 'info'
          }">${esc(x.status || DASH)}</span></td></tr>`,
      ),
      foot: `<tr class="total-row"><td colspan="3">Totals · ${num(rows.length)} records</td><td class="right num">${num(
        t.qty,
      )}</td><td class="right num currency">${ugx(t.val)}</td><td class="right num currency">${ugx(
        t.rec,
      )}</td><td class="right num currency">${ugx(t.out)}</td><td colspan="2"></td><td><span class="doc-badge badge-info">Reconciled</span></td></tr>`,
      colspan: 10,
      emptyText: 'No product or service sales in the selected window.',
    }),
    `<div class="observation-callout avoid-break"><strong>Recovery observation:</strong> ${num(
      k?.applications,
    )} applications (${num(k?.approved)} approved, ${num(k?.pending)} pending) issued ${ugx(
      k?.value_issued,
    )} of value. ${ugx(k?.recovered)} has been recovered (${pct(k?.recovery_rate)}), leaving ${ugx(
      k?.outstanding,
    )} outstanding.</div>`,
  ].join('');

  return shell({
    title: `Welile — Products & Services — ${r.range?.from} to ${r.range?.to}`,
    pages: [page(p1, 'Products & Services Report | Page 1 of 1')],
  });
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
