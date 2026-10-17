import { DASH, esc } from './welileReportDocument';
import {
  WELILE_OFFICE,
  WELILE_PARTNER_EMAIL,
  day,
  reportDocumentHtml,
  reportFooterHtml,
  reportHeaderHtml,
  runningHeaderHtml,
} from './partnerReportParts';

export interface PartnerStatementSection {
  name: string;
  headers: string[];
  rows: string[][];
  /** Column indices to right-align (money columns). */
  rightAlign?: number[];
}

export interface PartnerFinancialStatementInput {
  partner: string;
  profile: [string, string][];
  agreement?: [string, string][];
  totals: [string, string][];
  sections: PartnerStatementSection[];
  generatedAt?: Date;
}

/** Replaces machine underscores with spaces everywhere in the statement. */
export const humanize = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return s.replace(/_/g, ' ').trim() || '—';
};

/**
 * Same humanising for data-table cells, but empty values stay blank so the
 * statement never prints placeholder dashes for data that does not exist.
 */
const humanizeCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  const cleaned = s.replace(/_/g, ' ').trim();
  return cleaned === '—' ? '' : cleaned;
};

/* Pagination estimates in CSS px, same model as the partner statement. */
const SHEET_PX = 1000;
const PAGE1_CHROME_PX = 330;
const CONT_CHROME_PX = 60;
const ROW_PX = 17;
const PAIR_ROW_PX = 16;
const SECTION_HEAD_PX = 60;
const COMPLETION_PX = 95;

const pairTableHtml = (title: string, subtitle: string, body: [string, string][]): string => `
  <section>
    <div class="section-header-bar">
      <span class="section-title">${esc(title)}</span>
      <span class="section-subtitle">${esc(subtitle)}</span>
    </div>
    <div class="master-table-wrapper">
      <table class="master-schedule-table">
        <tbody>
          ${body.map(([k, v]) => `<tr>
            <td class="font-bold" style="width:38%;">${esc(humanize(k))}</td>
            <td>${esc(humanize(v))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </section>`;

const sectionTableHtml = (s: PartnerStatementSection, rows: string[][], withFoot: boolean): string => {
  const right = new Set(s.rightAlign || []);
  return `
  <section>
    <div class="section-header-bar">
      <span class="section-title">${esc(humanize(s.name))} (${rows.length === s.rows.length ? s.rows.length : `${rows.length} of ${s.rows.length}`})</span>
      <span class="section-subtitle">${withFoot ? 'Complete listing' : 'Continued on the next page'}</span>
    </div>
    <div class="master-table-wrapper">
      <table class="master-schedule-table">
        <thead><tr>
          ${s.headers.map((h, i) => `<th${right.has(i) ? ' class="text-right"' : ''}>${esc(humanize(h))}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            ${r.map((c, i) => `<td${right.has(i) ? ' class="text-right num"' : ''}>${esc(humanizeCell(c))}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </section>`;
};

/**
 * Partner 360 full financial statement, rendered with the exact same HTML
 * template and rasteriser as the partner portfolio statement, so every Welile
 * partner document carries the same header, tables, footer and look.
 */
export async function generatePartnerFinancialStatementPdf(
  input: PartnerFinancialStatementInput,
): Promise<Blob> {
  const generatedAt = input.generatedAt || new Date();
  const stamp = generatedAt.toISOString().slice(0, 10);
  const ref = `W-PFS-${stamp.slice(0, 4)}-${stamp.slice(5, 7)}${stamp.slice(8, 10)}`;
  const who = (humanize(input.partner) || 'Partner').toUpperCase();

  const phone = input.profile.find(([k]) => k === 'Phone')?.[1] || DASH;

  const header = reportHeaderHtml({
    meta: [
      { label: 'Account Number', value: phone, mono: true },
      { label: 'Statement Date', value: day(stamp), date: true },
      { label: 'Period Covered', value: 'All time' },
      { label: 'Statement Ref', value: ref, mono: true },
    ],
    customerName: who,
    customerLines: [
      'Prepared by Partner Operations for internal review',
      'Reporting Currency: UGX (Uganda Shilling)',
    ],
    branch: '<Welile Partner Portfolio Division>',
    summary: input.totals.slice(0, 5).map(([k, v], i, arr) => ({
      label: `${humanize(k)}:`,
      valueHtml: esc(humanize(v)),
      closing: i === arr.length - 1,
    })),
  });

  const note = `<div class="statement-disclosure-block">
  <div class="disclosure-title">Statement Note &amp; Data Disclosure</div>
  <div class="disclosure-body">
    This statement consolidates the partner's registered portfolios, recorded returns, top-ups, renewals and capital payouts exactly as held in the system of record. Columns with no recorded activity are omitted rather than shown blank. Figures are operational records maintained under the financial administration of Welile Technologies Limited.
  </div>
</div>`;

  /* ── Page 1: header + note + partner profile + position summary ── */
  const page1Sections = [
    pairTableHtml('Partner Profile', 'Identity and contact details on record', input.profile),
    pairTableHtml('Portfolio Position Summary', 'All-time totals across every portfolio', input.totals),
  ];
  if (input.agreement?.length) {
    page1Sections.push(pairTableHtml('Partnership Agreement', 'Signed agreement and payout details', input.agreement));
  }

  /* ── Data sections, paginated by estimated row height ── */
  interface Page { kind: 'first' | 'section'; html: string }
  const pages: Page[] = [{ kind: 'first', html: page1Sections.join('\n') }];

  for (const s of input.sections) {
    if (!s.rows.length) continue;
    const cap = Math.max(8, Math.floor((SHEET_PX - CONT_CHROME_PX - SECTION_HEAD_PX) / ROW_PX));
    for (let i = 0; i < s.rows.length; i += cap) {
      const chunk = s.rows.slice(i, i + cap);
      const isLast = i + cap >= s.rows.length;
      pages.push({ kind: 'section', html: sectionTableHtml(s, chunk, isLast) });
    }
  }

  // The completion panel closes the last page; if it will not fit there, it gets one.
  const completion = `<div class="statement-completion-panel">
  <div class="completion-panel-header">
    <span class="completion-title">Official Statement Completion Verification</span>
    <span class="font-mono text-muted" style="font-size:7px;">REF: ${esc(ref)}</span>
  </div>
  <div class="completion-body">
    <p>This document constitutes the complete Partner Financial Statement for <strong>${esc(who)}</strong> as of <strong>${day(stamp)}</strong>. All recorded capital contributions, returns, top-ups, renewals and payouts are maintained under the financial administration of Welile Technologies Limited.</p>
    <div class="completion-contact-row">
      <span><strong>Partner Office:</strong> ${WELILE_PARTNER_EMAIL}</span><span>&bull;</span>
      <span><strong>Partner Portal:</strong> welileapp.com</span><span>&bull;</span>
      <span><strong>Head Office:</strong> ${WELILE_OFFICE}</span>
    </div>
  </div>
</div>`;

  const last = pages[pages.length - 1];
  const lastCost = last.kind === 'first'
    ? (input.profile.length + input.totals.length + (input.agreement?.length ?? 0)) * PAIR_ROW_PX + PAGE1_CHROME_PX
    : SHEET_PX - CONT_CHROME_PX; // a full section page rarely has room left
  const panelOnOwnPage = lastCost + COMPLETION_PX > SHEET_PX;
  if (panelOnOwnPage) pages.push({ kind: 'section', html: completion });
  else last.html += `\n${completion}`;

  const totalPages = pages.length;
  const articles = pages.map((p, i) => {
    const pageNo = i + 1;
    const head = p.kind === 'first'
      ? `${header}${note}`
      : runningHeaderHtml({
          title: 'PARTNER FINANCIAL STATEMENT',
          accountLabel: 'Account', accountValue: phone,
          holderLabel: 'Partner', holder: who,
          date: day(stamp), page: pageNo, total: totalPages,
        });
    return `<article class="report-page">
  <div class="page-content">
    ${head}
    ${p.html}
  </div>
  ${reportFooterHtml({ docName: 'PARTNER FINANCIAL STATEMENT', ref, page: pageNo, total: totalPages })}
</article>`;
  });

  const html = reportDocumentHtml(`Welile — Partner Financial Statement — ${who}`, articles);
  const { renderReportPdfBlob } = await import('@/components/partner/renderAgreementPdf');
  return renderReportPdfBlob(html);
}
