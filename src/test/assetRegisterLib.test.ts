import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  kampalaToday, matchListKey, normaliseSerial, parseCost, parseSheetDate, validateAssetInput, describeAssetRpcError,
} from '@/lib/assetRegister/validation';
import {
  applyDuplicateMatches, commitPayload, duplicateCheckPayload, mapHeaders, parseAssetSheet, summariseImport, TEMPLATE_COLUMNS,
} from '@/lib/assetRegister/importParser';
import { buildErrorReportWorkbook, buildTemplateWorkbook } from '@/lib/assetRegister/template';
import { ASSET_STATUSES, assetCodes } from '@/lib/assetRegister/types';

const TODAY = '2026-10-26';
const departments = [{ key: 'finance', name: 'Finance' }, { key: 'operations', name: 'Operations' }];
const sites = [{ key: 'entebbe_hq', name: 'Entebbe Head Office', tag_code: 'HQ' }, { key: 'kololo', name: 'Kololo', tag_code: 'KOL' }];

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

  it('requires name, category and site and applies defaults on a full record', () => {
    const r = validateAssetInput({}, { today: TODAY });
    expect(r.errors.map((e) => e.field).sort()).toEqual(['category', 'name', 'site_key']);
    expect(r.errors.find((e) => e.field === 'site_key')?.message).toBe('Site is required');
    const ok = validateAssetInput({ name: 'Laptop', category: 'IT equipment', site_key: 'entebbe_hq' }, { today: TODAY });
    expect(ok.errors).toEqual([]);
    expect(ok.value).toMatchObject({ category: 'it_equipment', site_key: 'entebbe_hq', condition: 'good', status: 'in_use', currency: 'UGX' });
  });

  it('never accepts an asset tag from the browser, and a site cannot be cleared on edit', () => {
    const r = validateAssetInput({ name: 'Laptop', category: 'IT equipment', site_key: 'kololo', asset_tag: 'WEL-ICT-KOL-002' }, { today: TODAY });
    expect(r.errors).toEqual([{ field: 'asset_tag', message: 'Unknown or read-only field' }]);
    expect(validateAssetInput({ site_key: '' }, { partial: true, today: TODAY }).errors).toEqual([{ field: 'site_key', message: 'Site is required' }]);
    expect(validateAssetInput({ site_key: 'kololo' }, { partial: true, today: TODAY })).toEqual({ value: { site_key: 'kololo' }, errors: [] });
    expect(validateAssetInput({ notes: 'x' }, { partial: true, today: TODAY }).errors).toEqual([]); // edits without a site stay valid
  });

  it('shows the asset tag first and the permanent code second, or the code alone before a tag is issued', () => {
    expect(assetCodes({ asset_code: 'WEL-AST-000001', asset_tag: 'WEL-ICT-HQ-001' })).toEqual({ primary: 'WEL-ICT-HQ-001', secondary: 'WEL-AST-000001' });
    expect(assetCodes({ asset_code: 'WEL-AST-000002', asset_tag: 'WEL-ICT-KOL-002' })).toEqual({ primary: 'WEL-ICT-KOL-002', secondary: 'WEL-AST-000002' });
    expect(assetCodes({ asset_code: 'WEL-AST-000003', asset_tag: null })).toEqual({ primary: 'WEL-AST-000003', secondary: null });
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
    expect(mapHeaders(['Brand']).missingRequired).toEqual(['Asset Name', 'Category', 'Site']);
    // "Site" is the site picker field now; room / floor details go in Location
    expect(mapHeaders(['Site', 'Location', 'Office']).columns).toEqual(['site_key', 'location', null]);
  });

  it('resolves the Site cell by name, code or key, and reports an unknown or missing site', () => {
    const r = parseAssetSheet([
      ['Asset Name', 'Category', 'Site'],
      ['Laptop A', 'IT equipment', 'Entebbe Head Office'],
      ['Laptop B', 'IT equipment', 'kol'],
      ['Laptop C', 'IT equipment', 'entebbe_hq'],
      ['Laptop D', 'IT equipment', 'Jinja'],
      ['Laptop E', 'IT equipment', ''],
    ], { sites, today: TODAY });
    expect(r.rows.map((x) => x.value.site_key)).toEqual(['entebbe_hq', 'kololo', 'entebbe_hq', null, null]);
    expect(r.rows.map((x) => x.status)).toEqual(['valid', 'valid', 'valid', 'invalid', 'invalid']);
    expect(r.rows[3].errors).toEqual([{ field: 'site_key', message: 'Site "Jinja" is not an active site' }]);
    expect(r.rows[4].errors).toEqual([{ field: 'site_key', message: 'Site is required' }]);
  });

  it('refuses a sheet without required columns or over the row limit', () => {
    expect(parseAssetSheet([['Brand'], ['Dell']]).headerErrors[0]).toMatch(/Missing required/);
    const big = [['Asset Name', 'Category', 'Site'], ...Array.from({ length: 3 }, () => ['Chair', 'Furniture', 'HQ'])];
    const r = parseAssetSheet(big, { maxRows: 2 });
    expect(r.rows).toEqual([]);
    expect(r.headerErrors.join(' ')).toMatch(/limit is 2/);
  });

  it('gives row-level errors with spreadsheet row numbers and skips blank rows', () => {
    const sheet = [
      ['Asset Name', 'Category', 'Serial Number', 'Purchase Date', 'Purchase Cost', 'Department', 'Site'],
      ['Laptop', 'IT equipment', 'SN-1', '15/01/2025', '3,500,000', 'Finance', 'HQ'],
      ['', '', '', '', '', '', ''],
      ['X', 'Spaceship', '', 'tomorrow', '-1', 'Nowhere', 'Mars'],
    ];
    const r = parseAssetSheet(sheet, { departments, sites, today: TODAY });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ row_ref: '2', status: 'valid' });
    expect(r.rows[0].value).toMatchObject({ purchase_date: '2025-01-15', purchase_cost: '3500000', department_key: 'finance', site_key: 'entebbe_hq' });
    expect(r.rows[1].row_ref).toBe('4');
    expect(r.rows[1].status).toBe('invalid');
    expect(r.rows[1].errors.map((e) => e.field).sort()).toEqual(['category', 'department_key', 'name', 'purchase_cost', 'purchase_date', 'site_key']);
  });

  it('flags repeated serials (normalised, same category) as duplicates in the file', () => {
    const sheet = [
      ['Asset Name', 'Category', 'Serial Number', 'Site'],
      ['Printer A', 'Office equipment', 'ab-1', 'HQ'],
      ['Printer B', 'Office equipment', 'AB1', 'KOL'],
      ['Desk', 'Furniture', 'AB1', 'HQ'],
    ];
    const rows = parseAssetSheet(sheet, { sites, today: TODAY }).rows;
    expect(rows.map((r) => r.status)).toEqual(['valid', 'duplicate_file', 'valid']);
    expect(rows[1].errors[0].message).toContain('row 2');
  });

  it('applies server matches: serial matches block, possible matches warn and need opt-in', () => {
    const rows = parseAssetSheet([
      ['Asset Name', 'Category', 'Serial Number', 'Site'],
      ['Laptop', 'IT equipment', 'S1', 'HQ'],
      ['Chair', 'Furniture', '', 'KOL'],
      ['Desk', 'Furniture', '', 'HQ'],
    ], { sites, today: TODAY }).rows;
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
    const wb = buildTemplateWorkbook(XLSX, sites);
    expect(wb.SheetNames).toEqual(['Assets', 'Allowed values']);
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Assets, { header: 1, raw: true });
    expect(aoa[0]).toContain('Site *');
    const parsed = parseAssetSheet(aoa, { departments, sites, today: TODAY });
    expect(parsed.headerErrors).toEqual([]);
    expect(parsed.rows[0].status).toBe('valid');
    expect(parsed.rows[0].value.site_key).toBe('entebbe_hq');
    const allowed = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Allowed values'], { header: 1 });
    expect(allowed[0]).toEqual(['Category', 'Condition', 'Status', 'Site']);
    expect(allowed.map((r) => r[3])).toEqual(expect.arrayContaining(['Entebbe Head Office (HQ)', 'Kololo (KOL)']));
  });

  it('lists only rows that will not be imported, with reasons', () => {
    const rows = parseAssetSheet([['Asset Name', 'Category', 'Site'], ['Chair', 'Furniture', 'HQ'], ['', 'Furniture', 'HQ']], { sites, today: TODAY }).rows;
    const wb = buildErrorReportWorkbook(XLSX, rows);
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Rows not imported'], { header: 1 });
    expect(aoa).toHaveLength(2);
    expect(aoa[1][0]).toBe(3);
    expect(String(aoa[1][5])).toContain('Name is required');
  });
});
