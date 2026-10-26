/**
 * Browser-side PREVIEW validation for the CFO Asset Register.
 *
 * Mirrors `_asset_register_validate` in the Stage 1 migration so users see row-level errors before submitting.
 * The server re-validates every create, update and import; this file never decides what is stored.
 */
import {
  ASSET_CATEGORIES, ASSET_CONDITIONS, ASSET_STATUSES, ASSET_FIELDS,
  type AssetField, type AssetInput, type FieldError,
} from './types';

const TEXT_LIMITS: Partial<Record<AssetField, number>> = {
  brand: 120, model: 120, serial_number: 120, supplier: 200, invoice_reference: 120,
  location: 200, custodian_name: 200, notes: 2000,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COST_RE = /^\d{1,13}(\.\d{1,2})?$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_DATE = '1990-01-01';
const MAX_COST = 1_000_000_000_000;

/** Upper case, letters and digits only — the same rule as `assets.serial_number_norm`. */
export function normaliseSerial(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s || null;
}

const clean = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Accepts a key (`in_use`) or a label (`In use`, `IN-USE`) and returns the key, or null if unknown. */
export function matchListKey(
  list: ReadonlyArray<{ key: string; label: string }>,
  raw: unknown,
): string | null {
  const s = clean(raw);
  if (!s) return null;
  const q = squash(s);
  return list.find((i) => squash(i.key) === q || squash(i.label) === q)?.key ?? null;
}

/** Kampala calendar day as YYYY-MM-DD. */
export function kampalaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

function isRealIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Converts a spreadsheet date cell to YYYY-MM-DD.
 * Accepts Excel serial numbers, ISO strings and day-first strings (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY).
 * Returns `undefined` when the value is present but not a recognisable date.
 */
export function parseSheetDate(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw < 1 || raw > 2958465) return undefined;
    const ms = Date.UTC(1899, 11, 30) + Math.round(raw) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getFullYear();
    const mo = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (ISO_DATE_RE.test(s)) return isRealIsoDate(s) ? s : undefined;
  const dm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (dm) {
    const iso = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    return isRealIsoDate(iso) ? iso : undefined;
  }
  return undefined;
}

/** Normalises a cost cell ("3,500,000", "UGX 1 200.50", 1500) to a decimal string, or `undefined` if invalid. */
export function parseCost(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return undefined;
    return String(Math.round(raw * 100) / 100);
  }
  const s = String(raw).trim().replace(/^ugx\s*/i, '').replace(/[,\s]/g, '');
  if (!s) return null;
  return COST_RE.test(s) ? s : undefined;
}

export interface ValidationResult {
  value: Partial<AssetInput>;
  errors: FieldError[];
}

/**
 * Validates and normalises asset input. `partial` validates only the keys present (edit);
 * otherwise a full record is required and defaults are applied (create / import).
 */
export function validateAssetInput(
  input: Partial<Record<string, unknown>>,
  opts: { partial?: boolean; today?: string } = {},
): ValidationResult {
  const partial = !!opts.partial;
  const today = opts.today ?? kampalaToday();
  const errors: FieldError[] = [];
  const value: Partial<AssetInput> = {};
  const has = (k: AssetField) => !partial || Object.prototype.hasOwnProperty.call(input, k);
  const push = (field: string, message: string) => errors.push({ field, message });

  for (const k of Object.keys(input)) {
    if (!(ASSET_FIELDS as string[]).includes(k)) push(k, 'Unknown or read-only field');
  }

  if (has('name')) {
    const t = clean(input.name);
    if (!t) push('name', 'Name is required');
    else if (t.length < 2 || t.length > 200) push('name', 'Name must be 2 to 200 characters');
    value.name = t;
  }

  if (has('category')) {
    const raw = clean(input.category);
    const k = matchListKey(ASSET_CATEGORIES, raw);
    if (!raw) push('category', 'Category is required');
    else if (!k) push('category', 'Category is not one of the allowed values');
    value.category = k ?? raw;
  }

  if (has('condition')) {
    const raw = clean(input.condition) ?? (partial ? null : 'good');
    const k = matchListKey(ASSET_CONDITIONS, raw);
    if (!k) push('condition', 'Condition is not one of the allowed values');
    value.condition = k ?? raw;
  }

  if (has('status')) {
    const raw = clean(input.status) ?? (partial ? null : 'in_use');
    const k = matchListKey(ASSET_STATUSES, raw);
    if (!k) push('status', 'Status is not one of the allowed values');
    value.status = k ?? raw;
  }

  for (const [field, max] of Object.entries(TEXT_LIMITS) as Array<[AssetField, number]>) {
    if (!has(field)) continue;
    const t = clean(input[field]);
    if (t && t.length > max) push(field, `Must be at most ${max} characters`);
    (value as Record<string, string | null>)[field] = t;
  }

  if (has('purchase_date')) {
    const d = parseSheetDate(input.purchase_date);
    if (d === undefined) push('purchase_date', 'Purchase date must be YYYY-MM-DD');
    else if (d && (d < MIN_DATE || d > today)) push('purchase_date', 'Purchase date must be between 1990-01-01 and today');
    value.purchase_date = d ?? null;
  }

  if (has('purchase_cost')) {
    const c = parseCost(input.purchase_cost);
    if (c === undefined) push('purchase_cost', 'Purchase cost must be a positive number with at most 2 decimals');
    else if (c && Number(c) > MAX_COST) push('purchase_cost', 'Purchase cost is too large');
    value.purchase_cost = c ?? null;
  }

  if (has('currency')) {
    const t = (clean(input.currency) ?? (partial ? null : 'UGX'))?.toUpperCase() ?? null;
    if (!t || !/^[A-Z]{3}$/.test(t)) push('currency', 'Currency must be a 3-letter code');
    value.currency = t;
  }

  if (has('department_key')) value.department_key = clean(input.department_key);

  if (has('custodian_user_id')) {
    const t = clean(input.custodian_user_id);
    if (t && !UUID_RE.test(t)) push('custodian_user_id', 'Custodian is not a valid staff account');
    value.custodian_user_id = t;
  }

  return { value, errors };
}

/** Message for a server error raised by an `asset_register_*` RPC, including per-field details. */
export function describeAssetRpcError(err: unknown): { message: string; fieldErrors: FieldError[] } {
  const e = (err ?? {}) as { message?: string; code?: string; details?: string };
  let fieldErrors: FieldError[] = [];
  if (e.details) {
    try {
      const parsed = JSON.parse(e.details);
      if (Array.isArray(parsed)) fieldErrors = parsed.filter((x) => x && typeof x.message === 'string');
    } catch {
      /* details was plain text */
    }
  }
  const msg = e.message ?? '';
  if (e.code === '42501' || /NOT_AUTHORIZED|AUTH_REQUIRED/.test(msg)) {
    return { message: 'You are not authorised to change the asset register.', fieldErrors };
  }
  if (e.code === '40001' || msg.includes('STALE_VERSION')) {
    return { message: 'This asset was changed by someone else. Reload it and try again.', fieldErrors };
  }
  if (msg.includes('DUPLICATE_SERIAL')) {
    return { message: fieldErrors[0]?.message ?? 'This serial number is already registered.', fieldErrors };
  }
  if (msg.includes('FILE_ALREADY_IMPORTED')) {
    return { message: 'This file has already been imported.', fieldErrors };
  }
  if (msg.includes('NO_CHANGES')) return { message: 'Nothing was changed.', fieldErrors };
  if (msg.includes('VALIDATION_FAILED')) return { message: 'Some fields need attention.', fieldErrors };
  return { message: msg || 'The asset register could not complete the request.', fieldErrors };
}
