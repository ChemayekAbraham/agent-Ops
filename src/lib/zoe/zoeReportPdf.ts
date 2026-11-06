/**
 * Welile-styled A4 PDF and HTML Report Document Builder for Zoe (My Space Staff Assistant).
 *
 * Prompt 1 item (4) design shared with `supabase/functions/_shared/zoeReportPdf.ts`:
 *   - Welile purple header (`#6C21C4` / `#4C1696`) with embedded Welile logo and gold accent bar
 *   - Short written summary of 3 to 5 lines (`report.summaryLines`, passed through the number check)
 *   - Clean table that chooses columns by importance (`report.pdfColumns`, max 8 per page width,
 *     landscape when `>= 6` columns, portrait when `<= 5` columns)
 *   - Explicit proportional column widths, wrapped text, right-aligned numeric/money cells,
 *     `"UGX 1,234"` money formatting, repeated table header on every page, bold Totals row
 *     where applicable (`report.pdfTotalsRow`), `Page X of Y` page numbers, and a footer with
 *     official source and dates on every page
 *   - Font registration (`registerZoePdfFont`) and Unicode/Latin-1 text preservation (`normalizePdfText`)
 *     instead of stripping non-ASCII characters (`toAsciiSafe` removed).
 */
import {
  WELILE_BRAND_LOGO,
  docHeader,
  esc,
  kpiGrid,
  num,
  page,
  printReportHtml,
  sectionTitle,
  shell,
  table,
} from '@/lib/welileReportDocument';
import {
  buildZoeDisplayRows,
  formatZoeCellForDisplay,
  isMoneyColumn,
  isNumericColumn,
  type ZoeExportableReport,
  type ZoeReportCell,
} from './zoeReportData';

export { buildZoeDisplayRows };

export interface BuiltZoeReportPdf {
  filename: string;
  title: string;
  periodLabel: string;
  generatedAt: string;
  generatedBy: string;
  howCountedNote: string;
  summaryLines: string[];
  headers: string[];
  pdfHeaders: string[];
  rows: ZoeReportCell[][];
  pdfRows: ZoeReportCell[][];
  displayRows: string[][];
  pdfDisplayRows: string[][];
  totalsRow: ZoeReportCell[] | null;
  pdfTotalsRow: ZoeReportCell[] | null;
  omittedPdfColumns: number;
  orientation: 'portrait' | 'landscape';
  totalPages: number;
  html: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc?: any;
  pdfBytes?: Uint8Array;
}

const ROWS_PER_HTML_PAGE = 26;

// Embedded 163x59 Welile wordmark PNG (fallback when browser fetch is unavailable in Node/Vitest)
export const WELILE_LOGO_PNG_BASE64 =
  'data:image/png;base64,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';

const ZOE_PURPLE_HEADER_CSS = `
  .pdf-header {
    background: linear-gradient(135deg, #4C1696 0%, #6C21C4 60%, #4F46E5 100%);
    color: #FFFFFF;
    padding: 14px 16px;
    border-radius: 8px;
    border-bottom: 3px solid #EFB02E;
    margin-bottom: 14px;
  }
  .pdf-header .company-name,
  .pdf-header .report-title-main {
    color: #FFFFFF;
  }
  .pdf-header .report-subtitle-main {
    color: #E2D9F3;
  }
  .pdf-header .brand-logo-img {
    background: #FFFFFF;
    padding: 3px;
    border-radius: 6px;
  }
  .pdf-header .pdf-header-meta-table td {
    border-color: rgba(255, 255, 255, 0.22);
    background: rgba(255, 255, 255, 0.08);
    color: #FFFFFF;
  }
  .pdf-header .pdf-header-meta-table td.meta-lbl {
    background: rgba(255, 255, 255, 0.16);
    color: #F3E8FF;
  }
  .zoe-summary-box {
    background: #FAF8FF;
    border: 1px solid #DDD6FE;
    border-left: 4px solid #6C21C4;
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 12px;
  }
  .zoe-summary-box h4 {
    margin: 0 0 6px 0;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #4C1696;
  }
  .zoe-summary-box ul {
    margin: 0;
    padding-left: 16px;
    font-size: 11px;
    line-height: 1.45;
    color: #1E293B;
  }
  .zoe-totals-row td {
    background: #F3E8FF !important;
    font-weight: 700 !important;
    color: #3B0764 !important;
    border-top: 1.5px solid #6C21C4 !important;
  }
`;

/**
 * Normalizes typography while preserving all accented / Unicode Latin-1 characters (`À-ÿ`)
 * and currency text (`UGX 1,234`). Never strips accented names or shilling text.
 */
export function normalizePdfText(input: unknown): string {
  return String(input ?? '')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00B7|\u2022/g, '|')
    .replace(/\u00A0/g, ' ')
    // Strip only C0/C1 control characters (never strip >= 0xA0 accented characters)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

/**
 * Registers the `ZoeSans` font family in jsPDF so accented characters and UGX currency text
 * render cleanly without character stripping.
 * When custom TTF base64 strings are provided, embeds them in jsPDF's VFS; otherwise maps
 * `ZoeSans` to jsPDF's WinAnsi-encoded font table.
 */
export function registerZoePdfFont(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  customFontBase64?: { regular: string; bold: string },
): string {
  const familyName = 'ZoeSans';
  try {
    if (customFontBase64?.regular && customFontBase64?.bold) {
      doc.addFileToVFS('ZoeSans-Regular.ttf', customFontBase64.regular);
      doc.addFont('ZoeSans-Regular.ttf', familyName, 'normal');
      doc.addFileToVFS('ZoeSans-Bold.ttf', customFontBase64.bold);
      doc.addFont('ZoeSans-Bold.ttf', familyName, 'bold');
      return familyName;
    }
    return 'helvetica';
  } catch {
    return 'helvetica';
  }
}

async function loadLogoBase64(): Promise<string> {
  if (typeof WELILE_BRAND_LOGO === 'string' && WELILE_BRAND_LOGO.startsWith('data:image/')) {
    return WELILE_BRAND_LOGO;
  }
  try {
    if (
      typeof WELILE_BRAND_LOGO === 'string' &&
      typeof fetch !== 'undefined' &&
      typeof FileReader !== 'undefined'
    ) {
      const res = await fetch(WELILE_BRAND_LOGO);
      if (res.ok) {
        const blob = await res.blob();
        const dataUrl = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string) || null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
        if (dataUrl) return dataUrl;
      }
    }
  } catch {
    // Fall back to embedded PNG base64
  }
  return WELILE_LOGO_PNG_BASE64;
}

/**
 * Formats the PDF-selected columns (`report.pdfRows` / `report.pdfColumns`) into display strings.
 */
export function buildZoePdfDisplayRows(report: ZoeExportableReport): string[][] {
  const cols = report.pdfColumns?.length ? report.pdfColumns : report.columns;
  const sourceRows = report.pdfRows?.length ? report.pdfRows : report.rows;
  return sourceRows.map((row) =>
    row.map((cell, colIdx) => formatZoeCellForDisplay(cell, cols[colIdx] ?? `col_${colIdx}`)),
  );
}

/**
 * Computes proportional column widths (in mm) across the available table width so that
 * wide text columns get breathing room and numeric/money columns never wrap mid-number.
 */
export function computePdfColumnWidthsMm(
  columns: readonly string[],
  headers: readonly string[],
  displayRows: ReadonlyArray<ReadonlyArray<string>>,
  availableWidthMm: number,
): number[] {
  if (columns.length === 0) return [];
  const sample = displayRows.slice(0, 40);

  const weights = columns.map((col, idx) => {
    const headerLen = (headers[idx] || col).length;
    let maxCellLen = headerLen;
    for (const r of sample) {
      const val = String(r[idx] ?? '');
      if (val.length > maxCellLen) maxCellLen = val.length;
    }
    if (isMoneyColumn(col)) {
      return Math.max(Math.min(maxCellLen + 4, 26), 16);
    }
    if (isNumericColumn(col)) {
      return Math.max(Math.min(maxCellLen + 3, 20), 12);
    }
    return Math.max(Math.min(maxCellLen + 4, 42), 18);
  });

  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || 1;
  const safeAvailableMm = Math.max(availableWidthMm - 4.0, 20);
  return weights.map((w) => Math.floor(((w / totalWeight) * safeAvailableMm) * 10) / 10);
}

/**
 * Builds the Welile A4 HTML report document using `src/lib/welileReportDocument.ts`.
 */
export function buildZoeReportHtml(report: ZoeExportableReport): string {
  const pdfCols = report.pdfColumns?.length ? report.pdfColumns : report.columns;
  const pdfHeaders = report.pdfHeaders?.length ? report.pdfHeaders : report.headers;
  const pdfRows = report.pdfRows?.length ? report.pdfRows : report.rows;
  const pdfTotals = report.pdfTotalsRow ?? report.totalsRow;
  const summaryLines =
    report.summaryLines && report.summaryLines.length >= 3
      ? report.summaryLines
      : [
          `${report.title} covers ${report.periodLabel}.`,
          `This report contains ${report.rowCount.toLocaleString('en-US')} ${report.rowCount === 1 ? 'row' : 'rows'}.`,
          `Figures come directly from ${report.source}.`,
        ];

  const rowChunks: ZoeReportCell[][][] = [];
  if (pdfRows.length === 0) {
    rowChunks.push([]);
  } else {
    for (let i = 0; i < pdfRows.length; i += ROWS_PER_HTML_PAGE) {
      rowChunks.push(pdfRows.slice(i, i + ROWS_PER_HTML_PAGE));
    }
  }

  const totalPages = rowChunks.length;
  const headHtml = `<tr>
    <th class="text-center" style="width:28px;">#</th>
    ${pdfHeaders
      .map((h, idx) => {
        const colKey = pdfCols[idx] ?? '';
        const isRight = isMoneyColumn(colKey) || isNumericColumn(colKey);
        return `<th class="${isRight ? 'text-right' : ''}">${esc(normalizePdfText(h))}</th>`;
      })
      .join('')}
  </tr>`;

  const pagesHtml = rowChunks.map((chunk, pageIdx) => {
    const pageNum = pageIdx + 1;
    const rowOffset = pageIdx * ROWS_PER_HTML_PAGE;
    const isLastPage = pageNum === totalPages;

    const headerBlock = docHeader({
      title: pageNum === 1 ? normalizePdfText(report.title) : `${normalizePdfText(report.title)} (Continued)`,
      subtitle: normalizePdfText(report.subtitle),
      meta: [
        { label: 'Dates', value: normalizePdfText(report.periodLabel) },
        { label: 'Generated', value: normalizePdfText(report.generatedAt) },
        { label: 'Generated By', value: normalizePdfText(report.generatedBy) },
        {
          label: 'Rows',
          value: `${num(report.rowCount)} (Table)`,
        },
      ],
    });

    const summaryBlock =
      pageNum === 1
        ? `<div class="zoe-summary-box" data-testid="zoe-pdf-summary">
            <h4>Executive Summary</h4>
            <ul>
              ${summaryLines.map((line) => `<li>${esc(normalizePdfText(line))}</li>`).join('')}
            </ul>
          </div>`
        : '';

    const howCountedBlock =
      pageNum === 1
        ? `<div class="observation-callout" data-testid="zoe-pdf-how-counted">
            <strong>How this was counted:</strong> ${esc(normalizePdfText(report.howCountedNote))}
            ${
              report.omittedPdfColumns > 0
                ? `<br/><em>Showing the ${pdfHeaders.length} key columns for page width; all ${report.headers.length} columns are included in the Excel (.xlsx) export.</em>`
                : ''
            }
          </div>`
        : '';

    const kpiBlock =
      pageNum === 1 && report.summaryMetrics && report.summaryMetrics.length > 0
        ? kpiGrid(
            report.summaryMetrics.slice(0, 4).map((m) => ({
              label: m.label,
              value: m.formattedValue,
              sub: `Source: ${report.source}`,
              variant: 'primary' as const,
            })),
            4,
          )
        : '';

    const tableRowsHtml = chunk.map((row, rIdx) => {
      const globalRowIdx = rowOffset + rIdx;
      const cellsHtml = row
        .map((cell, cIdx) => {
          const key = pdfCols[cIdx] ?? `col_${cIdx}`;
          const isMoney = typeof cell === 'number' && isMoneyColumn(key);
          const isNum = typeof cell === 'number';
          const displayVal = normalizePdfText(formatZoeCellForDisplay(cell, key));
          const rawAttr = cell === null || cell === undefined ? '' : String(cell);
          return `<td class="${isMoney || isNum ? 'text-right font-mono' : ''}" data-raw-value="${esc(rawAttr)}">${esc(displayVal)}</td>`;
        })
        .join('');
      return `<tr data-row-index="${globalRowIdx}">
          <td class="text-center font-mono text-muted">${globalRowIdx + 1}</td>
          ${cellsHtml}
        </tr>`;
    });

    if (isLastPage && pdfTotals && pdfTotals.length > 0) {
      const totalsCellsHtml = pdfTotals
        .map((cell, cIdx) => {
          const key = pdfCols[cIdx] ?? `col_${cIdx}`;
          const isRight = typeof cell === 'number';
          const displayVal =
            cell === null || cell === undefined
              ? ''
              : cIdx === 0 && typeof cell === 'string'
                ? cell
                : normalizePdfText(formatZoeCellForDisplay(cell, key));
          return `<td class="${isRight ? 'text-right font-mono' : ''}">${esc(displayVal)}</td>`;
        })
        .join('');
      tableRowsHtml.push(
        `<tr class="zoe-totals-row" data-testid="zoe-pdf-totals-row">
          <td class="text-center font-mono"></td>
          ${totalsCellsHtml}
        </tr>`,
      );
    }

    const tableSection =
      sectionTitle(
        'Report Rows',
        `${num(report.rowCount)} total rows · ${normalizePdfText(report.periodLabel)}`,
      ) +
      table({
        head: headHtml,
        rows: tableRowsHtml,
        colspan: pdfHeaders.length + 1,
        emptyText: 'No rows returned for this period.',
      });

    const footerRight = `${normalizePdfText(report.title)} · Source: ${normalizePdfText(report.source)} · Dates: ${normalizePdfText(report.periodLabel)} · Generated by ${normalizePdfText(report.generatedBy)} at ${normalizePdfText(report.generatedAt)} · Page ${pageNum} of ${totalPages}`;

    return page(headerBlock + summaryBlock + howCountedBlock + kpiBlock + tableSection, footerRight);
  });

  void WELILE_BRAND_LOGO;

  return shell({
    title: `${normalizePdfText(report.title)} — ${normalizePdfText(report.periodLabel)}`,
    pages: pagesHtml,
    extraCss: ZOE_PURPLE_HEADER_CSS,
    noCharts: true,
  });
}

/**
 * Builds the downloadable A4 PDF document using `jspdf` + `jspdf-autotable` in Welile's
 * shared purple header, logo, 3-to-5 line verified summary, importance-selected columns
 * (max 8, landscape when `>= 6` columns), wrapped cells, right-aligned numbers, repeated
 * header on every page, bold Totals row, and `Page X of Y` footer.
 */
export async function buildZoeReportPdfDoc(
  report: ZoeExportableReport,
): Promise<BuiltZoeReportPdf> {
  const html = buildZoeReportHtml(report);
  const displayRows = buildZoeDisplayRows(report);
  const pdfCols = report.pdfColumns?.length ? report.pdfColumns : report.columns;
  const pdfHeaders = report.pdfHeaders?.length ? report.pdfHeaders : report.headers;
  const pdfRows = report.pdfRows?.length ? report.pdfRows : report.rows;
  const pdfTotals = report.pdfTotalsRow !== undefined ? report.pdfTotalsRow : report.totalsRow;
  const pdfDisplayRows = buildZoePdfDisplayRows(report);
  const summaryLines =
    report.summaryLines && report.summaryLines.length >= 3
      ? report.summaryLines.slice(0, 5)
      : [
          `${report.title} covers ${report.periodLabel}.`,
          `This report contains ${report.rowCount.toLocaleString('en-US')} ${report.rowCount === 1 ? 'row' : 'rows'}.`,
          `Figures come directly from ${report.source}.`,
        ];

  // Landscape when >= 6 data columns (plus '#' index column), portrait when <= 5 columns
  const orientation: 'portrait' | 'landscape' = pdfHeaders.length >= 6 ? 'landscape' : 'portrait';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jspdfMod: any = await import('jspdf');
  const JsPDFCtor = jspdfMod.jsPDF || jspdfMod.default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod.autoTable || autoTableMod;

  const doc = new JsPDFCtor({
    orientation,
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const fontName = registerZoePdfFont(doc);
  const pageW: number = doc.internal.pageSize.getWidth();
  const pageH: number = doc.internal.pageSize.getHeight();
  const margin = 12;
  const innerW = pageW - margin * 2;
  const logoB64 = await loadLogoBase64();

  // 1. Welile Purple Header Banner (#6C21C4 / #4C1696) with embedded Logo
  doc.setFillColor(76, 22, 150); // #4C1696
  doc.rect(0, 0, pageW, 27, 'F');
  doc.setFillColor(108, 33, 196); // #6C21C4
  doc.rect(0, 0, 5, 27, 'F');
  doc.setFillColor(239, 176, 46); // #EFB02E gold accent bar
  doc.rect(0, 25.4, pageW, 1.6, 'F');

  const headerTextX = margin + 30;
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(margin, 5, 26, 13.5, 1.5, 1.5, 'F');
  let logoDrawn = false;
  if (logoB64) {
    try {
      doc.addImage(logoB64, 'PNG', margin + 1.5, 6.2, 23, 11);
      logoDrawn = true;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) {
    doc.setTextColor(108, 33, 196);
    doc.setFont(fontName, 'bold');
    doc.setFontSize(10.5);
    doc.text('WELILE', margin + 13, 12.2, { align: 'center' });
    doc.setFillColor(239, 176, 46);
    doc.rect(margin + 4, 14.5, 18, 1.1, 'F');
  }

  doc.setTextColor(255, 255, 255);
  doc.setFont(fontName, 'bold');
  doc.setFontSize(13.5);
  doc.text(normalizePdfText(report.title), headerTextX, 11);

  doc.setFont(fontName, 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(233, 213, 255);
  doc.text(
    normalizePdfText(`Official Source: ${report.source}  |  Period: ${report.periodLabel}`),
    headerTextX,
    16.8,
  );

  doc.setFontSize(7.5);
  doc.setTextColor(255, 255, 255);
  doc.text(
    normalizePdfText(
      `Generated by ${report.generatedBy} on ${report.generatedAt}  |  ${report.rowCount.toLocaleString('en-US')} ${report.rowCount === 1 ? 'row' : 'rows'}`,
    ),
    headerTextX,
    22.2,
  );

  let cursorY = 31.5;

  // 2. Written Executive Summary Box (3 to 5 lines verified through number check)
  doc.setFont(fontName, 'normal');
  doc.setFontSize(8);
  const wrappedSummaryBullets: string[][] = summaryLines.map((line) =>
    doc.splitTextToSize(`- ${normalizePdfText(line)}`, innerW - 10),
  );
  const totalSummarySubLines = wrappedSummaryBullets.reduce((acc, arr) => acc + arr.length, 0);
  const summaryBoxH = Math.max(18, 7.5 + totalSummarySubLines * 4.0);

  doc.setFillColor(250, 248, 255); // #FAF8FF
  doc.setDrawColor(216, 180, 254); // #D8B4FE
  doc.roundedRect(margin, cursorY, innerW, summaryBoxH, 1.8, 1.8, 'FD');
  doc.setFillColor(108, 33, 196); // #6C21C4 left bar
  doc.roundedRect(margin, cursorY, 2.2, summaryBoxH, 1, 1, 'F');

  doc.setFont(fontName, 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(76, 22, 150);
  doc.text('SUMMARY (VERIFIED AGAINST OFFICIAL REPORT FIGURES)', margin + 5, cursorY + 5);

  doc.setFont(fontName, 'normal');
  doc.setFontSize(8);
  doc.setTextColor(30, 41, 59);
  let lineY = cursorY + 9.5;
  for (const bulletLines of wrappedSummaryBullets) {
    doc.text(bulletLines, margin + 5, lineY);
    lineY += bulletLines.length * 4.0;
  }

  cursorY += summaryBoxH + 3.5;

  // 3. Compact "How this was counted" + column selection note
  const omittedNote =
    report.omittedPdfColumns > 0
      ? ` Showing top ${pdfHeaders.length} of ${report.headers.length} columns by importance; all ${report.headers.length} columns are in the Excel (.xlsx) download.`
      : '';
  const howCountedText = normalizePdfText(
    `How this was counted: ${report.howCountedNote}${omittedNote}`,
  );
  doc.setFont(fontName, 'normal');
  doc.setFontSize(7.2);
  const noteLines: string[] = doc.splitTextToSize(howCountedText, innerW - 8);
  const noteBoxH = Math.max(8.5, noteLines.length * 3.5 + 3.5);

  doc.setFillColor(243, 244, 246);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(margin, cursorY, innerW, noteBoxH, 1.2, 1.2, 'FD');
  doc.setTextColor(71, 85, 105);
  doc.text(noteLines, margin + 4, cursorY + 4.2);

  cursorY += noteBoxH + 3.5;

  // 4. Clean Importance-Selected Table (max 8 data columns, explicit widths, wrapped text, right-aligned numbers, repeated header)
  const indexColWidthMm = 9;
  const colWidthsMm = computePdfColumnWidthsMm(
    pdfCols,
    pdfHeaders,
    pdfDisplayRows,
    innerW - indexColWidthMm,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columnStyles: Record<number, any> = {
    0: { cellWidth: indexColWidthMm, halign: 'center' },
  };
  pdfCols.forEach((colKey, idx) => {
    const sampleVals = pdfRows.map((r) => r[idx] ?? null);
    const isRight = isMoneyColumn(colKey) || isNumericColumn(colKey, sampleVals);
    columnStyles[idx + 1] = {
      cellWidth: colWidthsMm[idx],
      halign: isRight ? 'right' : 'left',
    };
  });

  const bodyMatrix: string[][] = pdfDisplayRows.map((r, idx) => [
    String(idx + 1),
    ...r.map((cell) => normalizePdfText(cell)),
  ]);

  if (pdfTotals && pdfTotals.length > 0) {
    const formattedTotals = pdfTotals.map((cell, cIdx) => {
      if (cell === null || cell === undefined) return '';
      if (cIdx === 0 && typeof cell === 'string') return normalizePdfText(cell);
      return normalizePdfText(formatZoeCellForDisplay(cell, pdfCols[cIdx] ?? `col_${cIdx}`));
    });
    bodyMatrix.push(['', ...formattedTotals]);
  }

  const hasTotalsRow = Boolean(pdfTotals && pdfTotals.length > 0);
  const totalsRowIndex = hasTotalsRow ? bodyMatrix.length - 1 : -1;

  autoTable(doc, {
    startY: cursorY,
    tableWidth: innerW,
    margin: { top: 18, left: margin, right: margin, bottom: 16 },
    showHead: 'everyPage',
    head: [['#', ...pdfHeaders.map((h) => normalizePdfText(h))]],
    body: bodyMatrix,
    columnStyles,
    styles: {
      font: fontName,
      fontSize: orientation === 'landscape' ? 7.5 : 8,
      cellPadding: 2.2,
      overflow: 'linebreak',
      valign: 'top',
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.12,
    },
    headStyles: {
      fillColor: [108, 33, 196], // #6C21C4 Welile purple
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      valign: 'middle',
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didParseCell: (hookData: any) => {
      if (hookData.section === 'head' && hookData.column.index > 0) {
        const colStyle = columnStyles[hookData.column.index];
        if (colStyle?.halign === 'right') {
          hookData.cell.styles.halign = 'right';
        }
      }
      if (hookData.section === 'body' && hookData.row.index === totalsRowIndex) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [243, 232, 255]; // #F3E8FF light purple totals fill
        hookData.cell.styles.textColor = [59, 7, 100]; // #3B0764 dark purple text
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didDrawPage: (hookData: any) => {
      // Compact continuation banner at top of pages 2..N
      if (hookData.pageNumber > 1) {
        doc.setFillColor(108, 33, 196);
        doc.rect(0, 0, pageW, 12, 'F');
        doc.setFillColor(239, 176, 46);
        doc.rect(0, 11.2, pageW, 0.8, 'F');
        doc.setFont(fontName, 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(255, 255, 255);
        doc.text(
          normalizePdfText(`${report.title} (Continued) — ${report.periodLabel}`),
          margin,
          7.8,
        );
      }
    },
  });

  // 5. Page-numbered footer ("Page X of Y") with official source and dates on every page
  const totalPages: number = doc.getNumberOfPages();
  const compactGenerator = report.generatedBy.replace(/\s*\([^)]*\)/g, '').trim() || report.generatedBy;
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(218, 208, 231);
    doc.line(margin, pageH - 11, pageW - margin, pageH - 11);
    doc.setFont(fontName, 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    const leftFooter = doc.splitTextToSize(
      normalizePdfText(`Welile Technologies Ltd · Source: ${report.source} · ${report.periodLabel}`),
      innerW * 0.48,
    );
    doc.text(leftFooter[0] ?? '', margin, pageH - 6.8);

    doc.setFont(fontName, 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(51, 65, 85);
    doc.text(
      normalizePdfText(`${compactGenerator} · ${report.generatedAt} · Page ${p} of ${totalPages}`),
      pageW - margin,
      pageH - 6.8,
      { align: 'right' },
    );
  }

  let pdfBytes: Uint8Array | undefined;
  try {
    if (typeof doc.output === 'function') {
      const ab = doc.output('arraybuffer');
      if (ab instanceof ArrayBuffer) {
        pdfBytes = new Uint8Array(ab);
      }
    }
  } catch {
    pdfBytes = undefined;
  }

  return {
    filename: `${report.filenameBase}.pdf`,
    title: report.title,
    periodLabel: report.periodLabel,
    generatedAt: report.generatedAt,
    generatedBy: report.generatedBy,
    howCountedNote: report.howCountedNote,
    summaryLines,
    headers: report.headers,
    pdfHeaders,
    rows: report.rows,
    pdfRows,
    displayRows,
    pdfDisplayRows,
    totalsRow: report.totalsRow,
    pdfTotalsRow: pdfTotals,
    omittedPdfColumns: report.omittedPdfColumns,
    orientation,
    totalPages,
    html,
    doc,
    pdfBytes,
  };
}

/**
 * Exports the Zoe report as a downloadable Welile PDF file (with fallback to `printReportHtml`
 * if `doc.save` is unavailable).
 */
export async function exportZoeReportPdf(
  report: ZoeExportableReport,
): Promise<BuiltZoeReportPdf> {
  const built = await buildZoeReportPdfDoc(report);
  if (built.doc && typeof built.doc.save === 'function') {
    built.doc.save(built.filename);
  } else {
    printReportHtml(built.html, report.title);
  }
  return built;
}
