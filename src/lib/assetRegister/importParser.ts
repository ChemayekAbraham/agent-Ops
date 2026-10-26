/**
 * Excel import parsing for the CFO Asset Register (pure functions — no network, no storage).
 *
 * Flow: sheet rows -> header mapping -> per-row preview validation -> in-file duplicate detection ->
 * server duplicate matches (`asset_register_check_duplicates`) -> preview statuses -> commit payload.
 * The server re-validates the payload and inserts all rows or none; nothing is ever updated or overwritten.
 */
import { ASSET_IMPORT_MAX_ROWS, type AssetField, type AssetInput, type DuplicateMatch, type FieldError } from './types';
import { normaliseSerial, validateAssetInput } from './validation';

export type ImportRowStatus = 'valid' | 'invalid' | 'duplicate_file' | 'duplicate_existing' | 'possible_duplicate';

export interface ImportRow {
  /** Spreadsheet row number (header is row 1), used for every error the user sees. */
  row_ref: string;
  value: Partial<AssetInput>;
  errors: FieldError[];
  status: ImportRowStatus;
  /** Existing asset code when the server reports a match. */
  match_code?: string | null;
}

/** Canonical template headers, in column order. */
export const TEMPLATE_COLUMNS: Array<{ header: string; field: AssetField; required?: boolean; example: string | number }> = [
  { header: 'Asset Name', field: 'name', required: true, example: 'Dell Latitude 5420 laptop' },
  { header: 'Category', field: 'category', required: true, example: 'IT equipment' },
  { header: 'Brand', field: 'brand', example: 'Dell' },
  { header: 'Model', field: 'model', example: 'Latitude 5420' },
  { header: 'Serial Number', field: 'serial_number', example: 'CN-0ABC12-34567' },
  { header: 'Purchase Date', field: 'purchase_date', example: '2025-01-15' },
  { header: 'Supplier', field: 'supplier', example: 'Kampala Computers Ltd' },
  { header: 'Purchase Cost', field: 'purchase_cost', example: 3500000 },
  { header: 'Currency', field: 'currency', example: 'UGX' },
  { header: 'Invoice / Evidence Reference', field: 'invoice_reference', example: 'INV-2025-0042' },
  { header: 'Department', field: 'department_key', example: 'Finance' },
  { header: 'Location', field: 'location', example: 'Head office, 2nd floor' },
  { header: 'Custodian', field: 'custodian_name', example: 'Jane Namubiru' },
  { header: 'Condition', field: 'condition', example: 'Good' },
  { header: 'Status', field: 'status', example: 'In use' },
  { header: 'Notes', field: 'notes', example: '' },
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const HEADER_ALIASES: Record<string, AssetField> = (() => {
  const map: Record<string, AssetField> = {};
  const add = (field: AssetField, ...names: string[]) => names.forEach((n) => { map[squash(n)] = field; });
  add('name', 'asset name', 'name', 'asset', 'item', 'item name', 'description');
  add('category', 'category', 'asset category', 'type', 'asset type');
  add('brand', 'brand', 'make', 'manufacturer');
  add('model', 'model', 'model number');
  add('serial_number', 'serial number', 'serial', 'serial no', 'sn', 's/n', 'imei');
  add('purchase_date', 'purchase date', 'date purchased', 'acquisition date', 'date of purchase', 'date');
  add('supplier', 'supplier', 'vendor', 'seller');
  add('purchase_cost', 'purchase cost', 'cost', 'purchase price', 'price', 'amount', 'cost ugx', 'purchase cost ugx');
  add('currency', 'currency');
  add('invoice_reference', 'invoice / evidence reference', 'invoice reference', 'invoice', 'invoice no', 'invoice number', 'evidence reference', 'receipt', 'receipt no');
  add('department_key', 'department', 'dept');
  add('location', 'location', 'site', 'office', 'room');
  add('custodian_name', 'custodian', 'assigned to', 'holder', 'user', 'custodian name');
  add('condition', 'condition');
  add('status', 'status');
  add('notes', 'notes', 'remarks', 'comment', 'comments');
  return map;
})();

export interface HeaderMapping {
  columns: Array<AssetField | null>;
  unknown: string[];
  missingRequired: string[];
  duplicated: string[];
}

export function mapHeaders(header: unknown[]): HeaderMapping {
  const seen = new Set<AssetField>();
  const duplicated: string[] = [];
  const unknown: string[] = [];
  const columns = header.map((h) => {
    const label = String(h ?? '').trim();
    if (!label) return null;
    const field = HEADER_ALIASES[squash(label.replace(/\(.*?\)|\*/g, ''))] ?? null;
    if (!field) { unknown.push(label); return null; }
    if (seen.has(field)) { duplicated.push(label); return null; }
    seen.add(field);
    return field;
  });
  const missingRequired = TEMPLATE_COLUMNS.filter((c) => c.required && !seen.has(c.field)).map((c) => c.header);
  return { columns, unknown, missingRequired, duplicated };
}

export interface ParseOptions {
  departments?: Array<{ key: string; name: string }>;
  today?: string;
  maxRows?: number;
}

export interface ParsedSheet {
  rows: ImportRow[];
  headerErrors: string[];
  unknownHeaders: string[];
}

/** Resolves a department cell (key or name, any case) to an active department key. */
function resolveDepartment(raw: unknown, departments: Array<{ key: string; name: string }>): { key: string | null; error?: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { key: null };
  const q = squash(s);
  const hit = departments.find((d) => squash(d.key) === q || squash(d.name) === q);
  return hit ? { key: hit.key } : { key: null, error: `Department "${s}" is not an active department` };
}

/** Parses an array-of-arrays sheet (first row = headers) into validated preview rows. */
export function parseAssetSheet(sheet: unknown[][], opts: ParseOptions = {}): ParsedSheet {
  const max = opts.maxRows ?? ASSET_IMPORT_MAX_ROWS;
  const departments = opts.departments ?? [];
  if (!sheet.length) return { rows: [], headerErrors: ['The file is empty.'], unknownHeaders: [] };

  const mapping = mapHeaders(sheet[0] ?? []);
  const headerErrors: string[] = [];
  if (mapping.missingRequired.length) headerErrors.push(`Missing required column(s): ${mapping.missingRequired.join(', ')}.`);
  if (mapping.duplicated.length) headerErrors.push(`Duplicate column(s) ignored: ${mapping.duplicated.join(', ')}.`);

  const body = sheet.slice(1)
    .map((cells, i) => ({ cells, row_ref: String(i + 2) }))
    .filter(({ cells }) => cells.some((c) => String(c ?? '').trim() !== ''));
  if (!body.length) headerErrors.push('The file has no data rows.');
  if (body.length > max) headerErrors.push(`The file has ${body.length} rows; the limit is ${max} per import.`);
  if (headerErrors.some((e) => e.startsWith('Missing') || e.startsWith('The file'))) {
    return { rows: [], headerErrors, unknownHeaders: mapping.unknown };
  }

  const rows: ImportRow[] = body.map(({ cells, row_ref }) => {
    const input: Record<string, unknown> = {};
    mapping.columns.forEach((field, col) => { if (field) input[field] = cells[col]; });
    const dept = resolveDepartment(input.department_key, departments);
    input.department_key = dept.key;
    const { value, errors } = validateAssetInput(input, { today: opts.today });
    if (dept.error) errors.push({ field: 'department_key', message: dept.error });
    return { row_ref, value, errors, status: errors.length ? 'invalid' : 'valid' };
  });

  return { rows: markFileDuplicates(rows), headerErrors, unknownHeaders: mapping.unknown };
}

/** Marks every row after the first that repeats a (category, normalised serial) pair within the file. */
export function markFileDuplicates(rows: ImportRow[]): ImportRow[] {
  const firstSeen = new Map<string, string>();
  return rows.map((r) => {
    if (r.status !== 'valid') return r;
    const serial = normaliseSerial(r.value.serial_number);
    if (!serial) return r;
    const key = `${r.value.category}:${serial}`;
    const first = firstSeen.get(key);
    if (first) {
      return {
        ...r,
        status: 'duplicate_file' as const,
        errors: [...r.errors, { field: 'serial_number', message: `Duplicate serial number in the file (same as row ${first})` }],
      };
    }
    firstSeen.set(key, r.row_ref);
    return r;
  });
}

/** Applies the server's duplicate matches. Serial matches block the row; possible matches are warnings. */
export function applyDuplicateMatches(rows: ImportRow[], matches: DuplicateMatch[]): ImportRow[] {
  const byRef = new Map(matches.map((m) => [String(m.row_ref), m]));
  return rows.map((r) => {
    if (r.status !== 'valid') return r;
    const m = byRef.get(r.row_ref);
    if (!m) return r;
    if (m.serial_match) {
      return {
        ...r,
        status: 'duplicate_existing' as const,
        match_code: m.serial_match,
        errors: [...r.errors, { field: 'serial_number', message: `Serial number already registered as ${m.serial_match}` }],
      };
    }
    if (m.possible_match) {
      return {
        ...r,
        status: 'possible_duplicate' as const,
        match_code: m.possible_match,
        errors: [...r.errors, { field: '_', message: `Looks like existing asset ${m.possible_match} (same name, brand, model, supplier and date)` }],
      };
    }
    return r;
  });
}

export function summariseImport(rows: ImportRow[]): Record<ImportRowStatus, number> & { total: number } {
  const out = { total: rows.length, valid: 0, invalid: 0, duplicate_file: 0, duplicate_existing: 0, possible_duplicate: 0 };
  rows.forEach((r) => { out[r.status] += 1; });
  return out;
}

/** Rows that will be sent for commit: valid rows, plus possible duplicates only when explicitly included. */
export function commitPayload(rows: ImportRow[], includePossibleDuplicates: boolean): Array<Partial<AssetInput> & { row_ref: string }> {
  return rows
    .filter((r) => r.status === 'valid' || (includePossibleDuplicates && r.status === 'possible_duplicate'))
    .map((r) => ({ row_ref: r.row_ref, ...r.value }));
}

/** Payload for `asset_register_check_duplicates` (valid rows only). */
export function duplicateCheckPayload(rows: ImportRow[]) {
  return rows
    .filter((r) => r.status === 'valid')
    .map((r) => ({
      row_ref: r.row_ref,
      name: r.value.name,
      category: r.value.category,
      brand: r.value.brand,
      model: r.value.model,
      supplier: r.value.supplier,
      serial_number: r.value.serial_number,
      purchase_date: r.value.purchase_date,
    }));
}

/** Hex SHA-256 of the uploaded file, so the server can refuse a second commit of the same file. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
