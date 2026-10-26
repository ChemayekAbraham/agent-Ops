/**
 * CFO Asset Register (Stage 1) — shared types and fixed lists.
 *
 * The server (`asset_register_*` RPCs, docs/pending-migrations/20261026150000_asset_register_stage1.sql)
 * is the only authority for validation, duplicate detection, asset codes and every figure. These lists
 * mirror its CHECK constraints so the browser can preview; they never widen what the server accepts.
 *
 * Purchase cost is register information only. It is never posted to the ledger.
 */

export const ASSET_CATEGORIES = [
  { key: 'it_equipment', label: 'IT equipment' },
  { key: 'furniture', label: 'Furniture' },
  { key: 'vehicles_motorbikes', label: 'Vehicles / Motorbikes' },
  { key: 'office_equipment', label: 'Office equipment' },
  { key: 'phones_tablets', label: 'Phones / Tablets' },
  { key: 'machinery', label: 'Machinery' },
  { key: 'other', label: 'Other' },
] as const;

export const ASSET_CONDITIONS = [
  { key: 'new', label: 'New' },
  { key: 'good', label: 'Good' },
  { key: 'fair', label: 'Fair' },
  { key: 'poor', label: 'Poor' },
  { key: 'damaged', label: 'Damaged' },
] as const;

export const ASSET_STATUSES = [
  { key: 'in_use', label: 'In use' },
  { key: 'in_storage', label: 'In storage' },
  { key: 'under_repair', label: 'Under repair' },
  { key: 'lost', label: 'Lost' },
  { key: 'disposed', label: 'Disposed' },
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number]['key'];
export type AssetCondition = (typeof ASSET_CONDITIONS)[number]['key'];
export type AssetStatus = (typeof ASSET_STATUSES)[number]['key'];

export const ASSET_IMPORT_MAX_ROWS = 1000;
export const ASSET_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_EVIDENCE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const ASSET_EVIDENCE_BUCKET = 'asset-evidence';

const labelOf = <T extends ReadonlyArray<{ key: string; label: string }>>(list: T, key: string | null | undefined) =>
  list.find((i) => i.key === key)?.label ?? (key ? key.replace(/_/g, ' ') : '—');

export const categoryLabel = (k: string | null | undefined) => labelOf(ASSET_CATEGORIES, k);
export const conditionLabel = (k: string | null | undefined) => labelOf(ASSET_CONDITIONS, k);
export const statusLabel = (k: string | null | undefined) => labelOf(ASSET_STATUSES, k);

/** Editable fields accepted by `asset_register_create` / `asset_register_update`. */
export interface AssetInput {
  name: string | null;
  category: string | null;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  purchase_date: string | null; // YYYY-MM-DD
  supplier: string | null;
  purchase_cost: string | null; // decimal string, max 2 decimals
  currency: string | null;
  invoice_reference: string | null;
  department_key: string | null;
  location: string | null;
  custodian_user_id: string | null;
  custodian_name: string | null;
  condition: string | null;
  status: string | null;
  notes: string | null;
}

export type AssetField = keyof AssetInput;

export const ASSET_FIELDS: AssetField[] = [
  'name', 'category', 'brand', 'model', 'serial_number', 'purchase_date', 'supplier', 'purchase_cost', 'currency',
  'invoice_reference', 'department_key', 'location', 'custodian_user_id', 'custodian_name', 'condition', 'status', 'notes',
];

/** A register row as returned by the server (display names resolved server-side). */
export interface Asset {
  id: string;
  asset_code: string;
  name: string;
  category: AssetCategory;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  purchase_date: string | null;
  supplier: string | null;
  purchase_cost: number | null;
  currency: string;
  invoice_reference: string | null;
  department_key: string | null;
  department_name: string | null;
  location: string | null;
  custodian_user_id: string | null;
  custodian_name: string | null;
  custodian_display: string | null;
  condition: AssetCondition;
  status: AssetStatus;
  photo_paths: string[];
  evidence_paths: string[];
  notes: string | null;
  import_batch_id: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_by: string;
  updated_by_name: string | null;
  updated_at: string;
}

export interface AssetEvent {
  id: string;
  event_type: 'created' | 'imported' | 'updated' | 'evidence_added';
  changed_fields: string[];
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string | null;
  actor_id: string;
  actor_name: string | null;
  batch_id: string | null;
  created_at: string;
}

export interface AssetDetail {
  asset: Asset;
  events: AssetEvent[];
}

export interface AssetListPage {
  total_count: number;
  limit: number;
  offset: number;
  items: Asset[];
}

export interface AssetListFilters {
  search: string;
  category: string | null;
  status: string | null;
  condition: string | null;
  department: string | null;
}

export interface AssetSummary {
  as_at: string;
  total_assets: number;
  active_assets: number;
  register_cost_ugx: number;
  active_register_cost_ugx: number;
  cost_missing_count: number;
  non_ugx_count: number;
  missing_evidence_count: number;
  missing_photo_count: number;
  missing_serial_count: number;
  unassigned_count: number;
  by_status: Partial<Record<AssetStatus, number>>;
  by_condition: Partial<Record<AssetCondition, number>>;
  by_category: Array<{ category: AssetCategory; count: number; cost_ugx: number }>;
}

export interface AssetReferenceData {
  departments: Array<{ key: string; name: string }>;
  custodians: Array<{ user_id: string; name: string; employee_id: string; department: string }>;
}

export interface FieldError {
  field: string;
  message: string;
}

export interface DuplicateMatch {
  row_ref: string;
  serial_match: string | null;
  possible_match: string | null;
}

export type ImportCommitResult =
  | { status: 'committed'; batch_id: string; row_count: number; inserted_count: number; asset_codes: string[] }
  | { status: 'rejected'; batch_id: string; row_count: number; inserted_count: 0; errors: Array<FieldError & { row_ref: string }> };
