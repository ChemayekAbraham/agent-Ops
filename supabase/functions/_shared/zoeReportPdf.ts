import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// Welile wordmark (163 x 59 PNG, transparent background)
const LOGO_BASE64 =
  "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";

const BRAND_DARK = rgb(0.298, 0.086, 0.588); // #4C1696
const BRAND = rgb(0.424, 0.129, 0.769); // #6C21C4
const GOLD = rgb(0.937, 0.69, 0.18); // #EFB02E
const INK = rgb(0.118, 0.161, 0.231); // #1E293B
const SUB = rgb(0.392, 0.455, 0.545); // #64748B
const LINE = rgb(0.855, 0.816, 0.906);
const SOFT = rgb(0.98, 0.973, 1.0); // #FAF8FF
const NOTE_BG = rgb(0.953, 0.957, 0.965); // #F3F4F6
const TOTALS_BG = rgb(0.953, 0.91, 1.0); // #F3E8FF
const TOTALS_INK = rgb(0.231, 0.027, 0.392); // #3B0764
const ZEBRA = rgb(0.973, 0.98, 0.988); // #F8FAFC
const WHITE = rgb(1, 1, 1);

const MAX_PDF_COLUMNS = 8;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Normalizes typography while preserving all WinAnsi / Latin-1 accented characters (`À-ÿ`)
 * and UGX shilling text (`UGX 1,234`). Never strips accented names.
 */
export function normalizeWinAnsiText(v: unknown, fallback = "-"): string {
  const s = String(v ?? "")
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00B7|\u2022/g, "|")
    .replace(/\u00A0/g, " ")
    // Keep printable ASCII (0x20-0x7E) and Latin-1 accented characters (0xA0-0xFF)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .trim();
  return s || fallback;
}

const MONEY_HEADER_RE =
  /\b(?:ugx|amount|balance|rent|fee|commission|bonus|principal|arrears|overdue|expected|collected|disbursed|payout|payable|receivable|float|withdrawable|locked|advance|salary|gross|net|deduction|cost|price|spend|budget|supplement|revised|expenditure|remaining|shortfall|uncollected|outstanding|repaid|funded|returns|topup|withdrawal|cash)\b/i;

const NON_MONEY_HEADER_RE =
  /\b(?:count|pct|percent|rate|ratio|days|hours|minutes|rank|score|id|phone|code|status|stage|bucket|name|title|email|role|date|time|month|year|week|day|note|reason|source|type|category|region|district|calls|plans|payers|started|missed|paid|part)\b/i;

function isMoneyHeader(header: string): boolean {
  const h = header.trim().toLowerCase();
  if (h.includes("ugx")) return true;
  if (NON_MONEY_HEADER_RE.test(h) && !h.includes("amount")) return false;
  return MONEY_HEADER_RE.test(h);
}

function isNumericColumnValues(
  header: string,
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
  colIdx: number,
): boolean {
  if (isMoneyHeader(header)) return true;
  const nonNull = rows
    .map((r) => r[colIdx])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (nonNull.length === 0) return false;
  return nonNull.every(
    (v) =>
      typeof v === "number" ||
      (typeof v === "string" && /^-?(?:UGX\s*)?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$/i.test(v.trim())),
  );
}

function formatCellValue(val: string | number | null | undefined, header: string): string {
  if (val === null || val === undefined || val === "") return "-";
  if (typeof val === "number" && Number.isFinite(val)) {
    if (isMoneyHeader(header)) {
      const rounded = Math.round(val);
      return rounded < 0
        ? `-UGX ${Math.abs(rounded).toLocaleString("en-US")}`
        : `UGX ${rounded.toLocaleString("en-US")}`;
    }
    return Number.isInteger(val)
      ? val.toLocaleString("en-US")
      : val.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return normalizeWinAnsiText(val, "-");
}

function scoreHeaderImportance(header: string, idx: number): number {
  const h = header.trim().toLowerCase();
  if (/\b(?:name|tenant|landlord|agent|supporter|staff|bucket|stage|department|category|day|code)\b/.test(h)) {
    return 100 - Math.min(idx, 10);
  }
  if (/\b(?:total|arrears|overdue|rent|collected|expected|uncollected|outstanding|amount|balance|principal|returns|calls|count|plans|payers)\b/.test(h)) {
    return 85 - Math.min(idx, 15);
  }
  if (/\b(?:status|outcome|answered|role|source|pct|percent|rate|date|due)\b/.test(h)) {
    return 70 - Math.min(idx, 15);
  }
  return 45 - Math.min(idx, 20);
}

function selectColumnsForPdf(
  headers: string[],
  rows: Array<Array<string | number | null>>,
): {
  selectedHeaders: string[];
  selectedRows: Array<Array<string | number | null>>;
  omittedCount: number;
} {
  if (headers.length <= MAX_PDF_COLUMNS) {
    return { selectedHeaders: headers, selectedRows: rows, omittedCount: 0 };
  }
  const topIndices = headers
    .map((h, idx) => ({ idx, score: scoreHeaderImportance(h, idx) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, MAX_PDF_COLUMNS)
    .map((x) => x.idx)
    .sort((a, b) => a - b);

  return {
    selectedHeaders: topIndices.map((i) => headers[i]),
    selectedRows: rows.map((r) => topIndices.map((i) => r[i] ?? null)),
    omittedCount: headers.length - topIndices.length,
  };
}

function computeTotalsRow(
  headers: string[],
  rows: Array<Array<string | number | null>>,
): Array<string | number | null> | null {
  if (rows.length < 2 || headers.length === 0) return null;
  let hasSum = false;
  const totals: Array<string | number | null> = headers.map((h, colIdx) => {
    const lower = h.toLowerCase();
    if (/\b(?:pct|percent|rate|avg|average|phone|date|id|code|status|stage|bucket|name|role|source|note)\b/.test(lower) && !isMoneyHeader(h)) {
      return colIdx === 0 ? "Total" : null;
    }
    const nums: number[] = [];
    for (const r of rows) {
      const v = r[colIdx];
      if (typeof v === "number" && Number.isFinite(v)) {
        nums.push(v);
      } else if (v !== null && v !== undefined && v !== "") {
        return colIdx === 0 ? "Total" : null;
      }
    }
    if (nums.length > 0 && (isMoneyHeader(h) || /\b(?:count|total|calls|plans|payers|started|missed|paid|part)\b/.test(lower))) {
      hasSum = true;
      const sum = nums.reduce((a, b) => a + b, 0);
      return Number.isInteger(sum) ? sum : Math.round(sum * 100) / 100;
    }
    return colIdx === 0 ? "Total" : null;
  });
  if (!hasSum) return null;
  if (totals[0] === null) totals[0] = "Total";
  return totals;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapTextLines(text: string, font: any, size: number, maxWidth: number, maxLines = 3): string[] {
  const clean = normalizeWinAnsiText(text, "-");
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) {
    return [clean];
  }
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // If a single token is wider than maxWidth, slice it
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) {
            chunk += ch;
          } else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 3 && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) {
      last = last.slice(0, -1);
    }
    kept[maxLines - 1] = `${last.trimEnd()}...`;
    return kept;
  }
  return lines;
}

function computeProportionalColumnWidthsPt(
  headers: string[],
  rows: Array<Array<string | number | null>>,
  availableWidthPt: number,
): number[] {
  if (headers.length === 0) return [];
  const sample = rows.slice(0, 40);
  const weights = headers.map((h, colIdx) => {
    let maxLen = h.length + 2;
    for (const r of sample) {
      const formatted = formatCellValue(r[colIdx], h);
      if (formatted.length > maxLen) maxLen = formatted.length;
    }
    if (isMoneyHeader(h)) return Math.max(Math.min(maxLen + 4, 24), 15);
    if (isNumericColumnValues(h, rows, colIdx)) return Math.max(Math.min(maxLen + 3, 18), 11);
    return Math.max(Math.min(maxLen + 4, 38), 16);
  });
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => (w / totalW) * availableWidthPt);
}

export interface ZoeSharedReportPdfData {
  report_title?: string;
  source?: string;
  period_label?: string;
  generated_at?: string;
  sender_name?: string;
  sender_email?: string;
  recipient_name?: string;
  recipient_email?: string;
  how_counted?: string;
  summary_lines?: string[];
  row_count?: number;
  headers?: string[];
  rows?: Array<Array<string | number | null>>;
}

/**
 * Renders a branded Welile A4 PDF (matching the client `zoeReportPdf.ts` design):
 *   - Purple Welile header banner (`#6C21C4` / `#4C1696`) + embedded Welile logo + gold accent bar
 *   - Short written summary of 3 to 5 lines (`summary_lines` or auto-verified summary lines)
 *   - Clean table that chooses columns by importance (max 8 columns, landscape when `>= 6` columns),
 *     explicit column widths, wrapped text, right-aligned numeric/money cells (`"UGX 1,234"`),
 *     repeated header on every page, and bold Totals row where applicable
 *   - Page numbers (`Page X of Y`) and footer with official source and dates on every page
 *   - Preserves accented characters (`À-ÿ`) and shilling text instead of stripping non-ASCII characters.
 */
export async function renderZoeReportPdf(data: ZoeSharedReportPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const title = normalizeWinAnsiText(data.report_title, "Zoe Staff Operations Report");
  const source = normalizeWinAnsiText(data.source, "Official Welile Read-Only Report");
  const periodLabel = normalizeWinAnsiText(data.period_label, "Current Period");
  const generatedAt = normalizeWinAnsiText(data.generated_at, new Date().toISOString());
  const senderLabel = normalizeWinAnsiText(
    data.sender_email ? `${data.sender_name || "Staff"} (${data.sender_email})` : data.sender_name,
    "Authenticated Staff Member",
  );
  const howCounted = normalizeWinAnsiText(
    data.how_counted,
    `Counted directly from official server source (${source}) for ${periodLabel}.`,
  );

  const rawHeaders =
    Array.isArray(data.headers) && data.headers.length > 0
      ? data.headers.map((h) => normalizeWinAnsiText(h, "Column"))
      : ["Metric", "Value"];
  const rawRows = Array.isArray(data.rows) ? data.rows : [];
  const rowCount = typeof data.row_count === "number" ? data.row_count : rawRows.length;

  const { selectedHeaders: headers, selectedRows: rows, omittedCount } = selectColumnsForPdf(
    rawHeaders,
    rawRows,
  );
  const totalsRow = computeTotalsRow(headers, rows);

  // Landscape when >= 6 data columns, portrait when <= 5 columns
  const isLandscape = headers.length >= 6;
  const PAGE_W = isLandscape ? 842 : 595;
  const PAGE_H = isLandscape ? 595 : 842;
  const M = 34;
  const R = PAGE_W - M;
  const CONTENT_W = R - M;

  const defaultSummaryLines: string[] = [
    `${title} covers ${periodLabel} (${rowCount.toLocaleString("en-US")} ${rowCount === 1 ? "row" : "rows"} returned).`,
    `Official source: ${source} (Africa/Kampala timezone, read-only server calculation).`,
  ];
  if (totalsRow) {
    const totalHighlights: string[] = [];
    headers.forEach((h, idx) => {
      const val = totalsRow[idx];
      if (idx > 0 && typeof val === "number") {
        totalHighlights.push(`${h}: ${formatCellValue(val, h)}`);
      }
    });
    if (totalHighlights.length > 0) {
      defaultSummaryLines.push(`Totals across rows — ${totalHighlights.slice(0, 3).join("; ")}.`);
    }
  }
  if (defaultSummaryLines.length < 3) {
    defaultSummaryLines.push(`Shared by ${senderLabel} on ${generatedAt}.`);
  }

  const summaryLines =
    Array.isArray(data.summary_lines) && data.summary_lines.length >= 3
      ? data.summary_lines.slice(0, 5).map((l) => normalizeWinAnsiText(l))
      : defaultSummaryLines.slice(0, 5);

  pdf.setTitle(`${title} (${periodLabel})`);
  pdf.setAuthor("Welile Technologies Limited");

  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logoImage: any = null;
  try {
    logoImage = await pdf.embedPng(LOGO_BASE64);
  } catch {
    logoImage = null;
  }

  const numColW = 24;
  const colWidths = computeProportionalColumnWidthsPt(headers, rows, CONTENT_W - numColW);
  const isRightAligned = headers.map((h, idx) => isNumericColumnValues(h, rows, idx));

  // Pre-wrap all rows so we can paginate accurately
  interface PreparedPdfRow {
    indexLabel: string;
    cellLines: string[][];
    height: number;
    isTotals?: boolean;
  }

  const preparedRows: PreparedPdfRow[] = rows.map((r, rIdx) => {
    const cellLines = headers.map((h, cIdx) => {
      const formatted = formatCellValue(r[cIdx], h);
      return wrapTextLines(formatted, reg, 7.5, Math.max(colWidths[cIdx] - 8, 20), 3);
    });
    const maxLineCount = Math.max(1, ...cellLines.map((lines) => lines.length));
    return {
      indexLabel: String(rIdx + 1),
      cellLines,
      height: Math.max(17, maxLineCount * 9.5 + 6),
    };
  });

  if (totalsRow) {
    const totalsCellLines = headers.map((h, cIdx) => {
      const val = totalsRow[cIdx];
      const formatted =
        val === null || val === undefined
          ? ""
          : cIdx === 0 && typeof val === "string"
            ? val
            : formatCellValue(val, h);
      return wrapTextLines(formatted, bold, 7.8, Math.max(colWidths[cIdx] - 8, 20), 2);
    });
    const maxLines = Math.max(1, ...totalsCellLines.map((l) => l.length));
    preparedRows.push({
      indexLabel: "",
      cellLines: totalsCellLines,
      height: Math.max(19, maxLines * 10 + 6),
      isTotals: true,
    });
  }

  // Paginate based on available vertical space
  const footerReserve = 42;
  const tableHeaderH = 20;
  const page1TopUsed = 74 + 10 + (18 + summaryLines.length * 11) + 8 + 26 + 10 + tableHeaderH;
  const nextPageTopUsed = 34 + 10 + tableHeaderH;
  const page1AvailH = PAGE_H - page1TopUsed - footerReserve;
  const nextPageAvailH = PAGE_H - nextPageTopUsed - footerReserve;

  const pagesRows: PreparedPdfRow[][] = [];
  if (preparedRows.length === 0) {
    pagesRows.push([]);
  } else {
    let currentChunk: PreparedPdfRow[] = [];
    let remainingH = page1AvailH;
    for (const pRow of preparedRows) {
      if (currentChunk.length > 0 && pRow.height > remainingH) {
        pagesRows.push(currentChunk);
        currentChunk = [pRow];
        remainingH = nextPageAvailH - pRow.height;
      } else {
        currentChunk.push(pRow);
        remainingH -= pRow.height;
      }
    }
    if (currentChunk.length > 0) {
      pagesRows.push(currentChunk);
    }
  }

  const totalPages = pagesRows.length;

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const chunk = pagesRows[pageIdx];

    let cursorY = PAGE_H;

    if (pageIdx === 0) {
      // 1. Purple Welile Header Banner (#6C21C4 / #4C1696)
      const headerH = 72;
      const headerBottom = PAGE_H - headerH;
      page.drawRectangle({
        x: 0,
        y: headerBottom,
        width: PAGE_W,
        height: headerH,
        color: BRAND_DARK,
      });
      page.drawRectangle({
        x: 0,
        y: headerBottom,
        width: 10,
        height: headerH,
        color: BRAND,
      });
      page.drawRectangle({
        x: 0,
        y: headerBottom,
        width: PAGE_W,
        height: 3.5,
        color: GOLD,
      });

      let titleX = M;
      if (logoImage) {
        const logoH = 26;
        const logoW = (logoImage.width * logoH) / logoImage.height;
        page.drawRectangle({
          x: M,
          y: PAGE_H - 42,
          width: logoW + 8,
          height: logoH + 6,
          color: WHITE,
        });
        page.drawImage(logoImage, {
          x: M + 4,
          y: PAGE_H - 39,
          width: logoW,
          height: logoH,
        });
        titleX = M + logoW + 18;
      }

      const titleLine = wrapTextLines(title, bold, 13, PAGE_W - titleX - M, 1)[0];
      page.drawText(titleLine, {
        x: titleX,
        y: PAGE_H - 27,
        size: 13,
        font: bold,
        color: WHITE,
      });
      const subLine = wrapTextLines(
        `Official Source: ${source}  |  Period: ${periodLabel}`,
        reg,
        8.5,
        PAGE_W - titleX - M,
        1,
      )[0];
      page.drawText(subLine, {
        x: titleX,
        y: PAGE_H - 42,
        size: 8.5,
        font: reg,
        color: SOFT,
      });
      const metaLine = wrapTextLines(
        `Shared by ${senderLabel} on ${generatedAt}  |  ${rowCount.toLocaleString("en-US")} ${rowCount === 1 ? "row" : "rows"}`,
        reg,
        8,
        PAGE_W - titleX - M,
        1,
      )[0];
      page.drawText(metaLine, {
        x: titleX,
        y: PAGE_H - 56,
        size: 8,
        font: reg,
        color: WHITE,
      });

      cursorY = headerBottom - 10;

      // 2. Written Summary Box (3 to 5 lines)
      const summaryBoxH = 18 + summaryLines.length * 11;
      page.drawRectangle({
        x: M,
        y: cursorY - summaryBoxH,
        width: CONTENT_W,
        height: summaryBoxH,
        color: SOFT,
        borderColor: LINE,
        borderWidth: 0.8,
      });
      page.drawRectangle({
        x: M,
        y: cursorY - summaryBoxH,
        width: 4,
        height: summaryBoxH,
        color: BRAND,
      });
      page.drawText("SUMMARY (VERIFIED AGAINST OFFICIAL REPORT FIGURES)", {
        x: M + 10,
        y: cursorY - 12,
        size: 7,
        font: bold,
        color: BRAND_DARK,
      });
      summaryLines.forEach((sLine, sIdx) => {
        const fitted = wrapTextLines(`- ${sLine}`, reg, 8, CONTENT_W - 20, 1)[0];
        page.drawText(fitted, {
          x: M + 10,
          y: cursorY - 24 - sIdx * 11,
          size: 8,
          font: reg,
          color: INK,
        });
      });
      cursorY -= summaryBoxH + 8;

      // 3. "How this was counted" + column selection note
      const omittedSuffix =
        omittedCount > 0
          ? ` Showing top ${headers.length} of ${rawHeaders.length} columns for page width; all columns are in the Excel (.xlsx) export.`
          : "";
      const noteLines = wrapTextLines(
        `How this was counted: ${howCounted}${omittedSuffix}`,
        reg,
        7.3,
        CONTENT_W - 16,
        2,
      );
      const noteBoxH = Math.max(22, noteLines.length * 9.5 + 8);
      page.drawRectangle({
        x: M,
        y: cursorY - noteBoxH,
        width: CONTENT_W,
        height: noteBoxH,
        color: NOTE_BG,
        borderColor: LINE,
        borderWidth: 0.6,
      });
      noteLines.forEach((nl, nlIdx) => {
        page.drawText(nl, {
          x: M + 8,
          y: cursorY - 11 - nlIdx * 9.5,
          size: 7.3,
          font: reg,
          color: SUB,
        });
      });
      cursorY -= noteBoxH + 10;
    } else {
      // Continuation header on pages 2..N
      const contH = 28;
      page.drawRectangle({
        x: 0,
        y: PAGE_H - contH,
        width: PAGE_W,
        height: contH,
        color: BRAND,
      });
      page.drawRectangle({
        x: 0,
        y: PAGE_H - contH,
        width: PAGE_W,
        height: 2,
        color: GOLD,
      });
      const contTitle = wrapTextLines(
        `${title} (Continued) — ${periodLabel}`,
        bold,
        9.5,
        CONTENT_W,
        1,
      )[0];
      page.drawText(contTitle, {
        x: M,
        y: PAGE_H - 18,
        size: 9.5,
        font: bold,
        color: WHITE,
      });
      cursorY = PAGE_H - contH - 10;
    }

    // 4. Repeated Table Header on every page
    page.drawRectangle({
      x: M,
      y: cursorY - tableHeaderH,
      width: CONTENT_W,
      height: tableHeaderH,
      color: BRAND,
    });
    page.drawText("#", {
      x: M + 6,
      y: cursorY - 13,
      size: 7.5,
      font: bold,
      color: WHITE,
    });

    let colX = M + numColW;
    headers.forEach((h, colIdx) => {
      const colW = colWidths[colIdx];
      const hText = wrapTextLines(h, bold, 7.5, Math.max(colW - 8, 16), 1)[0];
      const textW = bold.widthOfTextAtSize(hText, 7.5);
      const drawX = isRightAligned[colIdx]
        ? Math.max(colX + 4, colX + colW - textW - 4)
        : colX + 4;
      page.drawText(hText, {
        x: drawX,
        y: cursorY - 13,
        size: 7.5,
        font: bold,
        color: WHITE,
      });
      colX += colW;
    });
    cursorY -= tableHeaderH;

    // 5. Data Rows + Totals Row
    if (chunk.length === 0) {
      const emptyH = 18;
      page.drawRectangle({
        x: M,
        y: cursorY - emptyH,
        width: CONTENT_W,
        height: emptyH,
        color: WHITE,
        borderColor: LINE,
        borderWidth: 0.5,
      });
      page.drawText("No rows returned for this period.", {
        x: M + 8,
        y: cursorY - 12,
        size: 7.5,
        font: reg,
        color: SUB,
      });
      cursorY -= emptyH;
    } else {
      chunk.forEach((pRow, rIdx) => {
        const rowBg = pRow.isTotals
          ? TOTALS_BG
          : rIdx % 2 === 1
            ? ZEBRA
            : WHITE;
        page.drawRectangle({
          x: M,
          y: cursorY - pRow.height,
          width: CONTENT_W,
          height: pRow.height,
          color: rowBg,
          borderColor: pRow.isTotals ? BRAND : LINE,
          borderWidth: pRow.isTotals ? 0.8 : 0.4,
        });

        if (pRow.indexLabel) {
          page.drawText(pRow.indexLabel, {
            x: M + 6,
            y: cursorY - 11,
            size: 7,
            font: reg,
            color: SUB,
          });
        }

        let cellX = M + numColW;
        const rowFont = pRow.isTotals ? bold : reg;
        const rowFontSize = pRow.isTotals ? 7.8 : 7.5;
        const rowColor = pRow.isTotals ? TOTALS_INK : INK;

        pRow.cellLines.forEach((lines, colIdx) => {
          const colW = colWidths[colIdx];
          lines.forEach((lineStr, lineIdx) => {
            const lineW = rowFont.widthOfTextAtSize(lineStr, rowFontSize);
            const drawX = isRightAligned[colIdx]
              ? Math.max(cellX + 4, cellX + colW - lineW - 4)
              : cellX + 4;
            page.drawText(lineStr, {
              x: drawX,
              y: cursorY - 11 - lineIdx * 9.5,
              size: rowFontSize,
              font: rowFont,
              color: rowColor,
            });
          });
          cellX += colW;
        });

        cursorY -= pRow.height;
      });
    }

    // 6. Page-Numbered Footer ("Page X of Y") with official source and dates
    const footerY = 22;
    page.drawLine({
      start: { x: M, y: footerY + 11 },
      end: { x: R, y: footerY + 11 },
      thickness: 0.6,
      color: LINE,
    });
    const footerLeft = wrapTextLines(
      `Welile Technologies Limited | Source: ${source} | Dates: ${periodLabel}`,
      reg,
      7,
      CONTENT_W * 0.58,
      1,
    )[0];
    page.drawText(footerLeft, {
      x: M,
      y: footerY,
      size: 7,
      font: reg,
      color: SUB,
    });
    const footerRight = normalizeWinAnsiText(
      `Generated by ${senderLabel} (${generatedAt}) | Page ${pageIdx + 1} of ${totalPages}`,
    );
    const rightW = bold.widthOfTextAtSize(footerRight, 7);
    page.drawText(footerRight, {
      x: Math.max(M + CONTENT_W * 0.58, R - rightW),
      y: footerY,
      size: 7,
      font: bold,
      color: INK,
    });
  }

  return await pdf.save();
}
