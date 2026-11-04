// Minimal zero-dependency .xlsx (OpenXML) generator using fflate (already bundled via jspdf).
// Produces a valid single- or multi-sheet Excel workbook with:
//   - Guaranteed `.xlsx` filename extension (`ensureXlsxFilename`)
//   - Real numeric cells (`t="n"`) with `"UGX "#,##0` number format for money and `#,##0` for counts
//   - Date formatting (`yyyy-mm-dd`) for date columns
//   - Frozen top header row (`ySplit="1" state="frozen"`) and `<autoFilter>`
//   - Sensible explicit column widths (`<cols>`) and wrapped text (`wrapText="1"`)
//   - Optional bold Totals row at the bottom of the sheet.

import { zipSync, strToU8 } from 'fflate';

export type XlsxCell = string | number | boolean | null | undefined;

export type XlsxColumnType = 'text' | 'money' | 'integer' | 'decimal' | 'date';

export interface XlsxSheetInput {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
  columnTypes?: XlsxColumnType[];
  columnWidths?: number[];
  freezeHeader?: boolean;
  autoFilter?: boolean;
  totalsRow?: XlsxCell[] | null;
}

export type XlsxSheet = XlsxSheetInput;

const FflateU8 = zipSync({}).constructor as typeof Uint8Array;

function encodeUtf8(s: string): Uint8Array {
  const raw = strToU8(s);
  return raw instanceof FflateU8 ? raw : new FflateU8(raw);
}

async function logBulkXlsxExport(filename: string, sheetLabel: string, rowCount: number) {
  try {
    const { supabase } = await import('@/integrations/supabase/client');
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'bulk_data_exported',
      table_name: 'xlsx_export',
      record_id: null,
      metadata: { filename, sheet: sheetLabel, row_count: rowCount, format: 'xlsx' },
    });
  } catch (e) {
    console.warn('[xlsxExport] audit log insert failed:', e);
  }
}

/**
 * Ensures any Excel filename ends with `.xlsx` (adds `.xlsx` if missing, or converts `.xls` to `.xlsx`).
 */
export function ensureXlsxFilename(filename: string): string {
  const trimmed = (filename || 'export').trim();
  if (/\.xlsx$/i.test(trimmed)) {
    return trimmed.replace(/\.xlsx$/i, '.xlsx');
  }
  if (/\.xls$/i.test(trimmed)) {
    return trimmed.replace(/\.xls$/i, '.xlsx');
  }
  return `${trimmed.replace(/\.+$/, '')}.xlsx`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control chars illegal in XML 1.0
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colLetter(n: number): string {
  // 0-indexed -> A, B, ..., Z, AA, AB...
  let s = '';
  let num = n + 1;
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

const ISO_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/;

/**
 * Converts a YYYY-MM-DD string to an Excel 1900-epoch serial date number so Excel treats
 * date cells as real sortable/filterable dates with `numFmtId="167"` (`yyyy-mm-dd`).
 */
function isoDateToExcelSerial(isoStr: string): number | null {
  const m = isoStr.trim().match(ISO_DATE_PREFIX_RE);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcMs = Date.UTC(year, month - 1, day);
  // Excel 1900 epoch (with Lotus 1-2-3 leap-year offset): 1899-12-30 is serial 0
  const excelEpochMs = Date.UTC(1899, 11, 30);
  const serial = Math.round((utcMs - excelEpochMs) / 86_400_000);
  return Number.isFinite(serial) && serial > 0 ? serial : null;
}

/**
 * Style indices (`s="..."`) defined in `STYLES_XML`:
 *   0: Default text cell (wrapped, top-aligned)
 *   1: Header cell (Welile purple `#6C21C4` fill, white bold text, wrapped)
 *   2: Money numeric cell (`numFmtId="164"`, `"UGX "#,##0`, right-aligned)
 *   3: Integer numeric cell (`numFmtId="165"`, `#,##0`, right-aligned)
 *   4: Decimal numeric cell (`numFmtId="166"`, `#,##0.00`, right-aligned)
 *   5: Date cell (`numFmtId="167"`, `yyyy-mm-dd`, left-aligned)
 *   6: Totals row text/label cell (bold, `#F3E8FF` fill, top thin + bottom double border)
 *   7: Totals row money numeric cell (`numFmtId="164"`, `"UGX "#,##0`, bold, `#F3E8FF` fill, right-aligned)
 *   8: Totals row integer numeric cell (`numFmtId="165"`, `#,##0`, bold, `#F3E8FF` fill, right-aligned)
 */
function styleForDataCell(colType: XlsxColumnType | undefined, isNumeric: boolean): number {
  if (colType === 'money' && isNumeric) return 2;
  if (colType === 'integer' && isNumeric) return 3;
  if (colType === 'decimal' && isNumeric) return 4;
  if (colType === 'date') return 5;
  if (isNumeric) return 3;
  return 0;
}

function styleForTotalsCell(colType: XlsxColumnType | undefined, isNumeric: boolean): number {
  if (!isNumeric) return 6;
  if (colType === 'money') return 7;
  return 8;
}

function computeDefaultColumnWidths(sheet: XlsxSheetInput): number[] {
  return sheet.headers.map((header, colIdx) => {
    if (sheet.columnWidths && typeof sheet.columnWidths[colIdx] === 'number') {
      return Math.min(Math.max(sheet.columnWidths[colIdx], 10), 48);
    }
    const colType = sheet.columnTypes?.[colIdx];
    let maxLen = Math.max((header || '').length + 4, 12);
    const sampleRows = sheet.rows.slice(0, 100);
    for (const r of sampleRows) {
      const val = r[colIdx];
      if (val === null || val === undefined) continue;
      if (typeof val === 'number') {
        const formattedLen =
          colType === 'money'
            ? `UGX ${Math.round(val).toLocaleString('en-US')}`.length + 3
            : val.toLocaleString('en-US').length + 3;
        if (formattedLen > maxLen) maxLen = formattedLen;
      } else {
        const strLen = String(val).split('\n')[0].length + 2;
        if (strLen > maxLen) maxLen = strLen;
      }
    }
    return Math.min(Math.max(maxLen, 12), 42);
  });
}

function serializeDataCell(
  ref: string,
  val: XlsxCell,
  colType: XlsxColumnType | undefined,
  isTotalsRow = false,
): string {
  if (val === null || val === undefined || val === '') {
    if (isTotalsRow) {
      return `<c r="${ref}" s="6" t="inlineStr"><is><t></t></is></c>`;
    }
    return '';
  }

  // Coerce numeric strings on money/integer/decimal columns
  if (typeof val === 'string' && (colType === 'money' || colType === 'integer' || colType === 'decimal')) {
    const cleaned = val.replace(/^UGX\s*/i, '').replace(/,/g, '').trim();
    if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
      const numVal = Number(cleaned);
      if (Number.isFinite(numVal)) {
        const styleIdx = isTotalsRow
          ? styleForTotalsCell(colType, true)
          : styleForDataCell(colType, true);
        return `<c r="${ref}" s="${styleIdx}" t="n"><v>${numVal}</v></c>`;
      }
    }
  }

  if (typeof val === 'number' && Number.isFinite(val)) {
    const inferredType: XlsxColumnType =
      colType && colType !== 'text'
        ? colType
        : Number.isInteger(val)
          ? 'integer'
          : 'decimal';
    const styleIdx = isTotalsRow
      ? styleForTotalsCell(inferredType, true)
      : styleForDataCell(inferredType, true);
    return `<c r="${ref}" s="${styleIdx}" t="n"><v>${val}</v></c>`;
  }

  if (typeof val === 'boolean') {
    const styleIdx = isTotalsRow ? 6 : 0;
    return `<c r="${ref}" s="${styleIdx}" t="b"><v>${val ? 1 : 0}</v></c>`;
  }

  const strVal = String(val);
  if (!isTotalsRow && colType === 'date') {
    const serial = isoDateToExcelSerial(strVal);
    if (serial !== null) {
      return `<c r="${ref}" s="5" t="n"><v>${serial}</v></c>`;
    }
    return `<c r="${ref}" s="5" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(strVal)}</t></is></c>`;
  }

  const styleIdx = isTotalsRow ? 6 : 0;
  return `<c r="${ref}" s="${styleIdx}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(strVal)}</t></is></c>`;
}

function buildWorksheetXml(sheet: XlsxSheetInput, isFirstSheet = true): string {
  const colCount = Math.max(sheet.headers.length, 1);
  const lastCol = colLetter(colCount - 1);
  const dataRowCount = sheet.rows.length;
  const totalRowCount = 1 + dataRowCount + (sheet.totalsRow ? 1 : 0);
  const freezeHeader = sheet.freezeHeader !== false;
  const autoFilter = sheet.autoFilter !== false && sheet.headers.length > 0;
  const widths = computeDefaultColumnWidths(sheet);

  const colsXml =
    widths.length > 0
      ? `<cols>${widths
          .map(
            (w, idx) =>
              `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`,
          )
          .join('')}</cols>`
      : '';

  const sheetViewsXml = freezeHeader
    ? `<sheetViews><sheetView ${isFirstSheet ? 'tabSelected="1" ' : ''}workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView ${isFirstSheet ? 'tabSelected="1" ' : ''}workbookViewId="0"/></sheetViews>`;

  const rowsXml: string[] = [];

  // Row 1: Header row (style s="1")
  const headerCells = sheet.headers
    .map((h, idx) => {
      const ref = `${colLetter(idx)}1`;
      return `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(h ?? ''))}</t></is></c>`;
    })
    .join('');
  rowsXml.push(`<row r="1" ht="24" customHeight="1">${headerCells}</row>`);

  // Data rows (2 .. dataRowCount + 1)
  sheet.rows.forEach((row, rIdx) => {
    const rowNum = rIdx + 2;
    const cells = row
      .map((val, cIdx) => {
        const ref = `${colLetter(cIdx)}${rowNum}`;
        const colType = sheet.columnTypes?.[cIdx];
        return serializeDataCell(ref, val, colType, false);
      })
      .filter(Boolean)
      .join('');
    rowsXml.push(`<row r="${rowNum}">${cells}</row>`);
  });

  // Optional Totals row at the bottom
  if (sheet.totalsRow && sheet.totalsRow.length > 0) {
    const totalsRowNum = dataRowCount + 2;
    const totalsCells = sheet.totalsRow
      .map((val, cIdx) => {
        const ref = `${colLetter(cIdx)}${totalsRowNum}`;
        const colType = sheet.columnTypes?.[cIdx];
        return serializeDataCell(ref, val, colType, true);
      })
      .filter(Boolean)
      .join('');
    rowsXml.push(`<row r="${totalsRowNum}" ht="20" customHeight="1">${totalsCells}</row>`);
  }

  // AutoFilter covers header + data rows (excluding the totals row so sorting/filtering doesn't mix totals into rows)
  const filterEndRow = Math.max(1 + dataRowCount, 1);
  const autoFilterXml = autoFilter ? `<autoFilter ref="A1:${lastCol}${filterEndRow}"/>` : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCol}${totalRowCount}"/>
  ${sheetViewsXml}
  <sheetFormatPr defaultRowHeight="18"/>
  ${colsXml}
  <sheetData>${rowsXml.join('')}</sheetData>
  ${autoFilterXml}
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="4">
    <numFmt numFmtId="164" formatCode="&quot;UGX &quot;#,##0"/>
    <numFmt numFmtId="165" formatCode="#,##0"/>
    <numFmt numFmtId="166" formatCode="#,##0.00"/>
    <numFmt numFmtId="167" formatCode="yyyy-mm-dd"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="11"/><color rgb="FF18181B"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF3B0764"/><name val="Calibri"/></font>
    <font><sz val="11"/><color rgb="FF18181B"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF6C21C4"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF3E8FF"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="medium"><color rgb="FF4C1D95"/></bottom><diagonal/></border>
    <border><left/><right/><top style="thin"><color rgb="FF6C21C4"/></top><bottom style="double"><color rgb="FF4C1D95"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="9">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
    <xf numFmtId="167" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="2" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="2" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;

function sanitizeSheetName(raw: string, fallbackIndex: number): string {
  const cleaned = raw
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet${fallbackIndex}`;
}

/**
 * Builds the raw `.xlsx` ZIP/OpenXML bytes for one or more sheets.
 * Exported so unit tests can inspect the generated `.xlsx` archive directly.
 */
export async function buildXlsxWorkbookBytes(sheets: XlsxSheetInput[]): Promise<Uint8Array> {
  const validSheets: XlsxSheetInput[] =
    sheets.length > 0 ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }];

  const usedNames = new Set<string>();
  const normalizedSheets = validSheets.map((sheet, idx) => {
    let baseName = sanitizeSheetName(sheet.name, idx + 1);
    if (usedNames.has(baseName.toLowerCase())) {
      baseName = sanitizeSheetName(`${baseName.slice(0, 27)}_${idx + 1}`, idx + 1);
    }
    usedNames.add(baseName.toLowerCase());
    return { ...sheet, name: baseName };
  });

  const worksheetOverrides = normalizedSheets
    .map(
      (_, idx) =>
        `  <Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('\n');

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${worksheetOverrides}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const sheetEntriesXml = normalizedSheets
    .map(
      (sheet, idx) =>
        `    <sheet name="${xmlEscape(sheet.name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`,
    )
    .join('\n');

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${sheetEntriesXml}
  </sheets>
</workbook>`;

  const sheetRelsXml = normalizedSheets
    .map(
      (_, idx) =>
        `  <Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`,
    )
    .join('\n');

  const stylesRelId = normalizedSheets.length + 1;
  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRelsXml}
  <Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': encodeUtf8(contentTypesXml),
    '_rels/.rels': encodeUtf8(rootRelsXml),
    'xl/workbook.xml': encodeUtf8(workbookXml),
    'xl/_rels/workbook.xml.rels': encodeUtf8(workbookRelsXml),
    'xl/styles.xml': encodeUtf8(STYLES_XML),
  };

  normalizedSheets.forEach((sheet, idx) => {
    files[`xl/worksheets/sheet${idx + 1}.xml`] = encodeUtf8(buildWorksheetXml(sheet, idx === 0));
  });

  return zipSync(files, { level: 6 });
}

/**
 * Generates and downloads a multi-sheet `.xlsx` workbook in the browser.
 * Always ensures the download filename ends with `.xlsx`.
 */
export async function downloadXlsxWorkbook(
  filename: string,
  sheets: XlsxSheetInput[],
): Promise<string> {
  const safeName = ensureXlsxFilename(filename);
  const zipped = await buildXlsxWorkbookBytes(sheets);
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const blob = new Blob([zipped as unknown as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const totalRows = sheets.reduce((sum, s) => sum + s.rows.length, 0);
  void logBulkXlsxExport(safeName, sheets.map((s) => s.name).join(', '), totalRows);
  return safeName;
}

export async function downloadXlsx(
  filename: string,
  headers: string[],
  rows: XlsxCell[][],
  sheetName = 'Audit',
): Promise<void> {
  await downloadXlsxWorkbook(ensureXlsxFilename(filename), [
    { name: sheetName, headers, rows },
  ]);
}
