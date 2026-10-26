import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  kampalaToday, matchListKey, normaliseSerial, parseCost, parseSheetDate, validateAssetInput, describeAssetRpcError,
} from '@/lib/assetRegister/validation';
import {
  applyDuplicateMatches, commitPayload, duplicateCheckPayload, mapHeaders, parseAssetSheet, summariseImport, TEMPLATE_COLUMNS,
} from '@/lib/assetRegister/importParser';
import { buildErrorReportWorkbook, buildTemplateWorkbook } from '@/lib/assetRegister/template';
import { ASSET_STATUSES } from '@/lib/assetRegister/types';

const TODAY = '2026-10-26';
const departments = [{ key: 'finance', name: 'Finance' }, { key: 'operations', name: 'Operations' }];

describe('asset register — preview validation', () => {
  it('normalises serial numbers the same way as the database', () => {
    expect(normaliseSerial(' ab-12 cd/9 ')).toBe('AB12CD9');
    expect(normaliseSerial('---')).toBeNull();
    expect(normaliseSerial(null)).toBeNull();
  });

  it('matches list values by key or label, ignoring case and punctuation', () => {
    expect(matchListKey(ASSET_STATUSES, 'In use')).toBe('in_use');
    expect(matchListKey(ASSET_STATUSES, 'UNDER-REPAIR')).toBe('under_repair');
    expect(matchListKey(ASSET_STATUSES, 'broken')).toBeNull();
  });

  it('parses Excel serials, ISO and day-first dates, and rejects impossible dates', () => {
    expect(parseSheetDate(45672)).toBe('2025-01-15');
    expect(parseSheetDate('2025-01-15')).toBe('2025-01-15');
    expect(parseSheetDate('15/01/2025')).toBe('2025-01-15');
    expect(parseSheetDate('2025-02-30')).toBeUndefined();
    expect(parseSheetDate('next week')).toBeUndefined();
    expect(parseSheetDate('')).toBeNull();
  });

  it('parses costs with separators and refuses negatives or 3 decimals', () => {
    expect(parseCost('UGX 3,500,000')).toBe('3500000');
    expect(parseCost(1500.5)).toBe('1500.5');
    expect(parseCost('-5')).toBeUndefined();
    expect(parseCost('10.555')).toBeUndefined();
    expect(parseCost('')).toBeNull();
  });

  it('requires name and category and applies defaults on a full record', () => {
    const r = validateAssetInput({}, { today: TODAY });
    expect(r.errors.map((e) => e.field).sort()).toEqual(['category', 'name']);
    const ok = validateAssetInput({ name: 'Laptop', category: 'IT equipment' }, { today: TODAY });
    expect(ok.errors).toEqual([]);
    expect(ok.value).toMatchObject({ category: 'it_equipment', condition: 'good', status: 'in_use', currency: 'UGX' });
  });

  it('rejects future purchase dates, unknown fields and over-long text', () => {
    const r = validateAssetInput(
      { name: 'Laptop', category: 'furniture', purchase_date: '2026-10-27', asset_code: 'WEL-AST-000001', notes: 'x'.repeat(2001) },
      { today: TODAY },
    );
    const fields = r.errors.map((e) => e.field);
    expect(fields).toContain('purchase_date');
    expect(fields).toContain('asset_code');
    expect(fields).toContain('notes');
  });

  it('validates only the keys present on a partial (edit) record', () => {
    expect(validateAssetInput({ status: 'lost' }, { partial: true, today: TODAY })).toEqual({ value: { status: 'lost' }, errors: [] });
    expect(validateAssetInput({ name: '' }, { partial: true, today: TODAY }).errors[0].field).toBe('name');
  });

  it('gives the Kampala calendar day', () => {
    expect(kampalaToday(new Date('2026-10-25T22:30:00Z'))).toBe('2026-10-26');
  });

  it('decodes server errors into user messages and field errors', () => {
    expect(describeAssetRpcError({ code: '40001', message: 'STALE_VERSION' }).message).toMatch(/changed by someone else/);
    const dup = describeAssetRpcError({
      code: '23505', message: 'DUPLICATE_SERIAL',
      details: JSON.stringify([{ field: 'serial_number', message: 'Serial number already registered as WEL-AST-000004' }]),
    });
    expect(dup.message).toContain('WEL-AST-000004');
    expect(dup.fieldErrors[0].field).toBe('serial_number');
    expect(describeAssetRpcError({ code: '42501', message: 'NOT_AUTHORIZED' }).message).toMatch(/not authorised/);
  });
});

describe('asset register — Excel import parsing', () => {
  const header = TEMPLATE_COLUMNS.map((c) => (c.required ? `${c.header} *` : c.header));

  it('maps template headers and common aliases, reporting missing required columns', () => {
    expect(mapHeaders(header).missingRequired).toEqual([]);
    const m = mapHeaders(['Item', 'Type', 'S/N', 'Vendor', 'Mystery']);
    expect(m.columns).toEqual(['name', 'category', 'serial_number', 'supplier', null]);
    expect(m.unknown).toEqual(['Mystery']);
    expect(mapHeaders(['Brand']).missingRequired).toEqual(['Asset Name', 'Category']);
  });

  it('refuses a sheet without required columns or over the row limit', () => {
    expect(parseAssetSheet([['Brand'], ['Dell']]).headerErrors[0]).toMatch(/Missing required/);
    const big = [['Asset Name', 'Category'], ...Array.from({ length: 3 }, () => ['Chair', 'Furniture'])];
    const r = parseAssetSheet(big, { maxRows: 2 });
    expect(r.rows).toEqual([]);
    expect(r.headerErrors.join(' ')).toMatch(/limit is 2/);
  });

  it('gives row-level errors with spreadsheet row numbers and skips blank rows', () => {
    const sheet = [
      ['Asset Name', 'Category', 'Serial Number', 'Purchase Date', 'Purchase Cost', 'Department'],
      ['Laptop', 'IT equipment', 'SN-1', '15/01/2025', '3,500,000', 'Finance'],
      ['', '', '', '', '', ''],
      ['X', 'Spaceship', '', 'tomorrow', '-1', 'Nowhere'],
    ];
    const r = parseAssetSheet(sheet, { departments, today: TODAY });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ row_ref: '2', status: 'valid' });
    expect(r.rows[0].value).toMatchObject({ purchase_date: '2025-01-15', purchase_cost: '3500000', department_key: 'finance' });
    expect(r.rows[1].row_ref).toBe('4');
    expect(r.rows[1].status).toBe('invalid');
    expect(r.rows[1].errors.map((e) => e.field).sort()).toEqual(['category', 'department_key', 'name', 'purchase_cost', 'purchase_date']);
  });

  it('flags repeated serials (normalised, same category) as duplicates in the file', () => {
    const sheet = [
      ['Asset Name', 'Category', 'Serial Number'],
      ['Phone A', 'Phones / Tablets', 'ab-1'],
      ['Phone B', 'Phones / Tablets', 'AB1'],
      ['Desk', 'Furniture', 'AB1'],
    ];
    const rows = parseAssetSheet(sheet, { today: TODAY }).rows;
    expect(rows.map((r) => r.status)).toEqual(['valid', 'duplicate_file', 'valid']);
    expect(rows[1].errors[0].message).toContain('row 2');
  });

  it('applies server matches: serial matches block, possible matches warn and need opt-in', () => {
    const rows = parseAssetSheet([
      ['Asset Name', 'Category', 'Serial Number'],
      ['Laptop', 'IT equipment', 'S1'],
      ['Chair', 'Furniture', ''],
      ['Desk', 'Furniture', ''],
    ], { today: TODAY }).rows;
    expect(duplicateCheckPayload(rows)).toHaveLength(3);
    const applied = applyDuplicateMatches(rows, [
      { row_ref: '2', serial_match: 'WEL-AST-000001', possible_match: null },
      { row_ref: '3', serial_match: null, possible_match: 'WEL-AST-000002' },
    ]);
    expect(applied.map((r) => r.status)).toEqual(['duplicate_existing', 'possible_duplicate', 'valid']);
    expect(summariseImport(applied)).toMatchObject({ total: 3, valid: 1, duplicate_existing: 1, possible_duplicate: 1 });
    expect(commitPayload(applied, false).map((r) => r.row_ref)).toEqual(['4']);
    expect(commitPayload(applied, true).map((r) => r.row_ref)).toEqual(['3', '4']);
  });
});

describe('asset register — template and error report', () => {
  it('builds a template whose headers parse back without errors', () => {
    const wb = buildTemplateWorkbook(XLSX);
    expect(wb.SheetNames).toEqual(['Assets', 'Allowed values']);
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Assets, { header: 1, raw: true });
    const parsed = parseAssetSheet(aoa, { departments, today: TODAY });
    expect(parsed.headerErrors).toEqual([]);
    expect(parsed.rows[0].status).toBe('valid');
  });

  it('lists only rows that will not be imported, with reasons', () => {
    const rows = parseAssetSheet([['Asset Name', 'Category'], ['Chair', 'Furniture'], ['', 'Furniture']], { today: TODAY }).rows;
    const wb = buildErrorReportWorkbook(XLSX, rows);
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Rows not imported'], { header: 1 });
    expect(aoa).toHaveLength(2);
    expect(aoa[1][0]).toBe(3);
    expect(String(aoa[1][5])).toContain('Name is required');
  });
});
