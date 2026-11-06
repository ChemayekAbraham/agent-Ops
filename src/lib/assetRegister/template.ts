/**
 * Asset Register import template and rejected-row report (built with the lazily loaded `xlsx` module).
 */
import { ASSET_CATEGORIES, ASSET_CONDITIONS, ASSET_STATUSES, type AssetSite } from './types';
import { TEMPLATE_COLUMNS, type ImportRow } from './importParser';

type XLSXModule = typeof import('xlsx');

const STATUS_TEXT: Record<ImportRow['status'], string> = {
  valid: 'Ready',
  invalid: 'Invalid',
  duplicate_file: 'Duplicate in file',
  duplicate_existing: 'Already registered',
  possible_duplicate: 'Possible duplicate',
};

export function importStatusText(status: ImportRow['status']): string {
  return STATUS_TEXT[status];
}

/** Workbook with the Assets sheet (headers + one example row) and an Allowed values sheet (sites from reference data). */
export function buildTemplateWorkbook(XLSX: XLSXModule, sites: AssetSite[] = []) {
  const wb = XLSX.utils.book_new();
  const headers = TEMPLATE_COLUMNS.map((c) => (c.required ? `${c.header} *` : c.header));
  const example = TEMPLATE_COLUMNS.map((c) => c.example);
  const sheet = XLSX.utils.aoa_to_sheet([headers, example]);
  sheet['!cols'] = TEMPLATE_COLUMNS.map((c) => ({ wch: Math.max(14, c.header.length + 4) }));
  XLSX.utils.book_append_sheet(wb, sheet, 'Assets');

  const longest = Math.max(ASSET_CATEGORIES.length, ASSET_CONDITIONS.length, ASSET_STATUSES.length, sites.length);
  const allowed: (string | null)[][] = [['Category', 'Condition', 'Status', 'Site']];
  for (let i = 0; i < longest; i += 1) {
    allowed.push([ASSET_CATEGORIES[i]?.label ?? null, ASSET_CONDITIONS[i]?.label ?? null, ASSET_STATUSES[i]?.label ?? null,
      sites[i] ? `${sites[i].name} (${sites[i].tag_code})` : null]);
  }
  allowed.push([], ['Notes']);
  allowed.push(['* Asset Name, Category and Site are required. Site: the site name or its code (e.g. HQ, KOL).']);
  allowed.push(['Asset IDs (WEL-AST-…) and asset tags (e.g. WEL-ICT-HQ-001) are created by the system and never change.']);
  allowed.push(['Purchase Date: YYYY-MM-DD or DD/MM/YYYY. Purchase Cost: numbers only (register information, not posted to the ledger).']);
  allowed.push(['Department: the department name or key as shown in Welile. Up to 1,000 rows per file.']);
  allowed.push(['Serial numbers must be unique within a category. Existing assets are never updated by an import.']);
  const ref = XLSX.utils.aoa_to_sheet(allowed);
  ref['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 16 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(wb, ref, 'Allowed values');
  return wb;
}

/** Workbook listing every row that will not be imported, with its reasons. */
export function buildErrorReportWorkbook(XLSX: XLSXModule, rows: ImportRow[]) {
  const header = ['Row', 'Result', 'Asset Name', 'Category', 'Serial Number', 'Reasons'];
  const body = rows
    .filter((r) => r.status !== 'valid')
    .map((r) => [
      Number(r.row_ref),
      STATUS_TEXT[r.status],
      r.value.name ?? '',
      r.value.category ?? '',
      r.value.serial_number ?? '',
      r.errors.map((e) => (e.field === '_' ? e.message : `${e.field}: ${e.message}`)).join('; '),
    ]);
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
  sheet['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 30 }, { wch: 18 }, { wch: 20 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, sheet, 'Rows not imported');
  return wb;
}
