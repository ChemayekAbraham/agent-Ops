/**
 * Branded HTML report renderer for the Agent Operations comprehensive report.
 *
 * Mirrors the Welile daily-operations email template: purple header band,
 * numbered white section cards, KPI tiles (3-up, stacking on mobile) and
 * compact data tables. Presentation only — no data is derived here.
 */

export type TileTone = 'neutral' | 'positive' | 'negative';

export interface ReportTile {
  label: string;
  value: string;
  hint?: string;
  tone?: TileTone;
}

export interface ReportTable {
  headers: string[];
  rows: (string | number)[][];
  /** Column indices rendered left-aligned; all others are right-aligned. */
  leftAlign?: number[];
  footer?: (string | number)[];
  caption?: string;
}

export interface ReportSection {
  title: string;
  note?: string;
  tiles?: ReportTile[];
  tables?: ReportTable[];
}

export interface AgentOpsReportHtmlInput {
  title: string;
  windowLabel: string;
  sourceNote: string;
  sections: ReportSection[];
  watchlist?: string[];
  footerNote: string;
  logoUrl?: string;
}

const PURPLE = '#6c21c4';
const INK = '#1e1b2e';
const MUTED = '#787484';
const BORDER = '#e6e1f0';

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const toneStyle = (tone: TileTone = 'neutral') =>
  tone === 'positive'
    ? 'background:#f1fbf6;border:1px solid #c9ecdb'
    : tone === 'negative'
      ? 'background:#fff5f8;border:1px solid #f6cfe0'
      : 'background:#faf8ff;border:1px solid #ece5fb';

function renderTiles(tiles: ReportTile[]): string {
  if (!tiles.length) return '';
  const cells = tiles.map(
    (t) => `<td class="tile" width="33%" style="width:33.33%;padding:0 4px 8px 4px;vertical-align:top">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="${toneStyle(t.tone)};border-radius:12px">
        <tr><td style="padding:12px 14px">
          <div style="font-size:10px;color:${MUTED};text-transform:uppercase;font-weight:700;letter-spacing:.4px">${esc(t.label)}</div>
          <div class="tile-val" style="font-size:19px;font-weight:800;color:${INK};margin-top:4px;line-height:1.2">${esc(t.value)}</div>
          ${t.hint ? `<div style="font-size:11px;color:${MUTED};margin-top:3px;line-height:1.4">${esc(t.hint)}</div>` : ''}
        </td></tr>
      </table>
    </td>`,
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 3) {
    const chunk = cells.slice(i, i + 3);
    while (chunk.length < 3) chunk.push('<td class="tile" width="33%" style="width:33.33%"></td>');
    rows.push(`<tr>${chunk.join('')}</tr>`);
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;table-layout:fixed;margin-top:10px">${rows.join('')}</table>`;
}

function renderTable(t: ReportTable): string {
  const left = new Set(t.leftAlign ?? [0]);
  const th = t.headers
    .map(
      (h, i) =>
        `<th style="text-align:${left.has(i) ? 'left' : 'right'};padding:7px 8px;font-size:10.5px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid ${BORDER}">${esc(h)}</th>`,
    )
    .join('');
  const body = t.rows.length
    ? t.rows
        .map(
          (r) =>
            `<tr>${r
              .map(
                (c, i) =>
                  `<td style="padding:7px 8px;font-size:12.5px;color:${INK};text-align:${left.has(i) ? 'left' : 'right'};border-bottom:1px solid #f2eff9;white-space:${left.has(i) ? 'normal' : 'nowrap'}">${esc(c)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('')
    : `<tr><td colspan="${t.headers.length}" style="padding:16px 8px;font-size:12px;color:${MUTED};text-align:center">No qualifying records in this window.</td></tr>`;
  const foot = t.footer
    ? `<tfoot><tr>${t.footer
        .map(
          (c, i) =>
            `<td style="padding:8px;font-size:12.5px;font-weight:800;color:${INK};text-align:${left.has(i) ? 'left' : 'right'};border-top:1px solid ${BORDER};white-space:nowrap">${esc(c)}</td>`,
        )
        .join('')}</tr></tfoot>`
    : '';
  return `${t.caption ? `<div style="font-size:12px;font-weight:700;color:${INK};margin-top:16px">${esc(t.caption)}</div>` : ''}<table class="data" role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr>${th}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

function renderSection(s: ReportSection, index: number): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fff;border:1px solid ${BORDER};border-radius:14px;margin-top:16px;border-collapse:separate">
      <tr><td class="pad" style="padding:18px 20px">
        <div style="font-size:13px;font-weight:800;color:${PURPLE};text-transform:uppercase;letter-spacing:.4px">
          <span style="color:#9a94ab">${index}</span>&nbsp;&nbsp;${esc(s.title)}
        </div>
        ${s.note ? `<div style="font-size:12px;color:${MUTED};margin-top:6px;line-height:1.5">${esc(s.note)}</div>` : ''}
        ${renderTiles(s.tiles ?? [])}
        ${(s.tables ?? []).map(renderTable).join('')}
      </td></tr>
    </table>`;
}

export function buildAgentOpsReportHtml(input: AgentOpsReportHtmlInput): string {
  const watchlist = (input.watchlist ?? []).filter(Boolean);
  const sections = input.sections.map((s, i) => renderSection(s, i + 1)).join('\n');
  const watchlistBlock = watchlist.length
    ? renderSection(
        {
          title: 'Watchlist',
          note: 'Only items needing action are listed. Clean areas are omitted rather than printed as zeros.',
        },
        input.sections.length + 1,
      ).replace(
        '</td></tr>\n    </table>',
        `${watchlist
          .map(
            (w) =>
              `<div style="border-left:3px solid #b45309;background:#fffdf5;border-radius:0 8px 8px 0;padding:9px 12px;margin-top:8px;font-size:12.5px;color:${INK}">${esc(w)}</div>`,
          )
          .join('')}</td></tr>\n    </table>`,
      )
    : '';

  return `<!DOCTYPE html><html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(input.title)} - ${esc(input.windowLabel)}</title>
  <style type="text/css">
    @media only screen and (max-width:600px) {
      .wrap { padding: 10px !important; }
      .pad { padding: 14px 12px !important; }
      .tile { display:block !important; width:100% !important; max-width:100% !important; }
      .tile-val { font-size: 17px !important; }
      table.data td, table.data th { padding: 6px 5px !important; font-size: 11.5px !important; }
    }
    @media print { body { background:#fff !important; } .wrap { padding:0 !important; } }
  </style>
</head><body style="margin:0;padding:0;background:#f6f4fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK}">
  <div class="wrap" style="padding:20px">
  <div style="max-width:700px;margin:0 auto">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${PURPLE};border-radius:14px">
      <tr><td class="pad" style="padding:22px 24px">
        <img src="${esc(input.logoUrl || 'https://welileapp.com/welile-logo.png')}" alt="Welile" width="104" style="display:block;max-width:104px;height:auto;margin-bottom:10px" />
        <div style="color:#fff;font-size:19px;font-weight:800;letter-spacing:-.3px">${esc(input.title)}</div>
        <div style="color:#e8dcfa;font-size:12.5px;margin-top:6px;line-height:1.5">
          ${esc(input.windowLabel)} · ${esc(input.sourceNote)}
        </div>
      </td></tr>
    </table>

${sections}
${watchlistBlock}

    <div style="padding:16px 6px;color:${MUTED};font-size:11px;text-align:center;line-height:1.6">
      ${esc(input.footerNote)}
    </div>
  </div></div></body></html>`;
}

/** Opens the rendered report in a new tab (print-ready) and offers it as a download. */
export function downloadAgentOpsReportHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
