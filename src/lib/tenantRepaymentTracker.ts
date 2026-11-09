/**
 * Tenant Repayment Tracker (CFO, read-only). Every figure comes from the database functions in migrations
 * 20261108090000 / 20261108120000 (get_cfo_tenant_repayment_register / get_cfo_tenant_repayment_detail); this file only
 * shapes, filters, summarises and exports what they return. It never recomputes a balance from a stored status.
 *
 * Collected = Money In (Tenant Products and Services) entries on the plan from 1 Oct 2026, plus collection receipts before
 * that date (those months were not posted to Money In per collection).
 */

export interface RepaymentPlanRow {
  rent_request_id: string;
  status: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  landlord_name: string | null;
  funded_at: string | null;
  clock_bucket: string | null;
  clock_start: string | null;
  clock_end: string | null;
  duration_days: number | null;
  principal: number;
  access_fee: number;
  request_fee: number;
  fees: number;
  obligation: number;
  disbursed: number | null;
  verified_collected: number;
  /** Money In (Tenant Products and Services) on the plan from 1 Oct 2026, net. */
  money_in_collected: number;
  /** Receipts and ledger-backed repayment records before 1 Oct 2026. */
  pre_cutoff_collected: number;
  receipts_count: number;
  last_receipt_at: string | null;
  reversed_amount: number;
  reversed_count: number;
  ledger_backed_amount: number;
  unverified_amount: number;
  unverified_count: number;
  stored_repaid: number;
  stored_outstanding: number;
  calc_outstanding: number;
  progress_pct: number | null;
  repaid_without_receipts: number;
  manual_reduction_total: number;
  manual_reduction_count: number;
  unreceipted_repaid_increase: number;
  obligation_reduced: number;
  last_adjustment_at: string | null;
  books_receivable: number | null;
  receipts_not_posted: number;
  expected_to_date: number | null;
  arrears: number | null;
  days_behind: number | null;
  is_legacy: boolean;
  exceptions: string[];
}

export type ExceptionCode =
  | 'completed_with_balance'
  | 'repaid_without_receipts'
  | 'manual_balance_reduction'
  | 'obligation_reduced_after_funding'
  | 'receipts_exceed_recorded'
  | 'collected_more_than_owed'
  | 'unverified_repayment_records'
  | 'receipt_not_in_ledger'
  | 'books_obligation_mismatch';

export const EXCEPTIONS: Record<ExceptionCode, { label: string; meaning: string; severity: 'high' | 'medium' }> = {
  completed_with_balance: {
    label: 'Completed with balance',
    meaning: 'Marked completed, but what was collected (Money In) is below what the tenant owed.',
    severity: 'high',
  },
  repaid_without_receipts: {
    label: 'Repaid without collections',
    meaning: 'The plan records more as repaid than was collected (Money In, or receipts before 1 Oct 2026).',
    severity: 'high',
  },
  manual_balance_reduction: {
    label: 'Balance reduced by an edit',
    meaning: 'The balance was lowered by an edit, not by a payment. It is not counted as a repayment.',
    severity: 'high',
  },
  obligation_reduced_after_funding: {
    label: 'Obligation lowered after funding',
    meaning: 'What the tenant owes was reduced after the money was paid out.',
    severity: 'high',
  },
  receipts_exceed_recorded: {
    label: 'Collected above recorded repaid',
    meaning: 'More was collected than the plan records as repaid.',
    severity: 'medium',
  },
  collected_more_than_owed: {
    label: 'Collected more than owed',
    meaning: 'What was collected exceeds the total the tenant owed.',
    severity: 'medium',
  },
  unverified_repayment_records: {
    label: 'Unverified repayment records',
    meaning: 'Repayment records with no receipt and no ledger entry. They are not counted.',
    severity: 'medium',
  },
  receipt_not_in_ledger: {
    label: 'Receipt not on Money In',
    meaning: 'A collection receipt from 1 Oct 2026 has no matching Money In entry, so it is not counted.',
    severity: 'medium',
  },
  books_obligation_mismatch: {
    label: 'Books differ from obligation',
    meaning: 'The receivable in the books is different from what the tenant owes.',
    severity: 'medium',
  },
};

export function exceptionLabel(code: string): string {
  return (EXCEPTIONS as Record<string, { label: string }>)[code]?.label ?? code.replace(/_/g, ' ');
}

export const ACTIVE_STATUSES = ['funded', 'repaying'];
export const COUNTED_STATUSES = ['funded', 'repaying', 'completed'];

/** Behind the payout-clock schedule by at least UGX 1,000. */
export const isBehind = (r: RepaymentPlanRow) => Number(r.arrears ?? 0) >= 1000;

export interface TrackerKpis {
  activePlans: number;
  activeOutstanding: number;
  totalOutstanding: number;
  storedOutstanding: number;
  overduePlans: number;
  overdueArrears: number;
  completedPlans: number;
  completedWithBalance: number;
  plansWithExceptions: number;
  highExceptions: number;
}

export function computeKpis(rows: RepaymentPlanRow[]): TrackerKpis {
  const counted = rows.filter((r) => COUNTED_STATUSES.includes(r.status));
  const active = rows.filter((r) => ACTIVE_STATUSES.includes(r.status));
  const sum = (xs: RepaymentPlanRow[], f: (r: RepaymentPlanRow) => number) => xs.reduce((t, r) => t + (Number(f(r)) || 0), 0);
  const overdue = counted.filter(isBehind);
  return {
    activePlans: active.length,
    activeOutstanding: sum(active, (r) => r.calc_outstanding),
    totalOutstanding: sum(counted, (r) => r.calc_outstanding),
    storedOutstanding: sum(counted, (r) => r.stored_outstanding),
    overduePlans: overdue.length,
    overdueArrears: sum(overdue, (r) => r.arrears ?? 0),
    completedPlans: rows.filter((r) => r.status === 'completed').length,
    completedWithBalance: rows.filter((r) => r.exceptions.includes('completed_with_balance')).length,
    plansWithExceptions: rows.filter((r) => r.exceptions.length > 0).length,
    highExceptions: rows.filter((r) => r.exceptions.some((e) => (EXCEPTIONS as Record<string, { severity: string }>)[e]?.severity === 'high')).length,
  };
}

export type StatusFilter = 'all' | 'active' | 'completed' | 'other';
export type ScheduleFilter = 'all' | 'behind' | 'on_track';

export interface TrackerFilters {
  search: string;
  status: StatusFilter;
  schedule: ScheduleFilter;
  exception: 'all' | 'any' | 'none' | ExceptionCode;
}

export const DEFAULT_FILTERS: TrackerFilters = { search: '', status: 'all', schedule: 'all', exception: 'all' };

const digits = (s: string) => s.replace(/\D/g, '');

export function filterRows(rows: RepaymentPlanRow[], f: TrackerFilters): RepaymentPlanRow[] {
  const q = f.search.trim().toLowerCase();
  const qd = digits(q);
  return rows.filter((r) => {
    if (f.status === 'active' && !ACTIVE_STATUSES.includes(r.status)) return false;
    if (f.status === 'completed' && r.status !== 'completed') return false;
    if (f.status === 'other' && COUNTED_STATUSES.includes(r.status)) return false;
    if (f.schedule === 'behind' && !isBehind(r)) return false;
    if (f.schedule === 'on_track' && isBehind(r)) return false;
    if (f.exception === 'any' && r.exceptions.length === 0) return false;
    if (f.exception === 'none' && r.exceptions.length > 0) return false;
    if (f.exception !== 'all' && f.exception !== 'any' && f.exception !== 'none' && !r.exceptions.includes(f.exception)) return false;
    if (!q) return true;
    const text = [r.tenant_name, r.agent_name, r.landlord_name, r.rent_request_id].filter(Boolean).join(' ').toLowerCase();
    if (text.includes(q)) return true;
    // phone search ignores spaces, + and the leading 0 / 256
    if (qd.length >= 4 && r.tenant_phone) {
      const p = digits(r.tenant_phone);
      const tail = qd.replace(/^(256|0)/, '');
      return p.includes(qd) || (tail.length >= 4 && p.endsWith(tail));
    }
    return false;
  });
}

export type SortKey = 'calc_outstanding' | 'arrears' | 'obligation' | 'verified_collected' | 'funded_at' | 'repaid_without_receipts';

export function sortRows(rows: RepaymentPlanRow[], key: SortKey, dir: 'asc' | 'desc' = 'desc'): RepaymentPlanRow[] {
  const v = (r: RepaymentPlanRow) => (key === 'funded_at' ? (r.funded_at ? Date.parse(r.funded_at) : 0) : Number(r[key] ?? 0));
  return [...rows].sort((a, b) => (dir === 'desc' ? v(b) - v(a) : v(a) - v(b)));
}

/* ------------------------------------------------------------------ CSV */
// The download goes through the shared downloadCsv (src/lib/csvExport.ts): RFC 4180 quoting, formula-injection guard,
// UTF-8 BOM and a csv_exported audit entry. This only decides the columns.

export const CSV_COLUMNS: Array<[keyof RepaymentPlanRow | 'exception_labels', string]> = [
  ['rent_request_id', 'Rent Plan ID'], ['tenant_name', 'Tenant'], ['tenant_phone', 'Tenant phone'], ['agent_name', 'Agent'],
  ['landlord_name', 'Landlord'], ['status', 'Status'], ['funded_at', 'Funded at'], ['clock_bucket', 'Payout clock'],
  ['clock_start', 'Clock start'], ['clock_end', 'Clock end'], ['principal', 'Principal (UGX)'], ['access_fee', 'Access fee (UGX)'],
  ['request_fee', 'Request fee (UGX)'], ['obligation', 'Total obligation (UGX)'], ['disbursed', 'Disbursed per books (UGX)'],
  ['verified_collected', 'Collected (UGX)'], ['money_in_collected', 'Collected on Money In from 1 Oct 2026 (UGX)'],
  ['pre_cutoff_collected', 'Collected before 1 Oct 2026, receipts (UGX)'], ['receipts_count', 'Receipts'], ['last_receipt_at', 'Last receipt'],
  ['calc_outstanding', 'Outstanding (UGX)'], ['progress_pct', 'Repaid (%)'],
  ['stored_repaid', 'Recorded repaid (UGX)'], ['stored_outstanding', 'Recorded outstanding (UGX)'],
  ['repaid_without_receipts', 'Recorded repaid above collections (UGX)'], ['manual_reduction_total', 'Manual reductions (UGX)'],
  ['obligation_reduced', 'Obligation lowered after funding (UGX)'], ['reversed_amount', 'Reversed receipts (UGX)'],
  ['unverified_amount', 'Unverified repayment records, not counted (UGX)'], ['expected_to_date', 'Expected to date (UGX)'],
  ['arrears', 'Arrears (UGX)'], ['days_behind', 'Days behind'], ['books_receivable', 'Books receivable (UGX)'],
  ['is_legacy', 'Funded before 1 Oct 2026'], ['exception_labels', 'Exceptions'],
];

type Cell = string | number | null | undefined;

/** Headers and rows for downloadCsv. Numbers stay numbers; booleans become Yes / No; exceptions become their labels. */
export function csvTable(rows: RepaymentPlanRow[]): { headers: string[]; rows: Cell[][] } {
  const cell = (r: RepaymentPlanRow, k: (typeof CSV_COLUMNS)[number][0]): Cell => {
    if (k === 'exception_labels') return r.exceptions.map(exceptionLabel).join('; ');
    const v = r[k];
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.join('; ');
    return v as Cell;
  };
  return { headers: CSV_COLUMNS.map(([, h]) => h), rows: rows.map((r) => CSV_COLUMNS.map(([k]) => cell(r, k))) };
}

export function csvFileName(asAt: Date = new Date()): string {
  return `tenant-repayment-tracker-${asAt.toISOString().slice(0, 10)}.csv`;
}

/* ------------------------------------------------------------------ detail */

export interface ReceiptRow {
  id: string; at: string; amount: number; method: string | null; reference: string | null; tracking_id: string | null;
  agent: string | null; path: string; reversed: boolean; reversed_at: string | null; ledger_posted: boolean; ledger_checked: boolean;
  /** Counted in Collected: receipts before 1 Oct 2026 only (later ones count through Money In). */
  counted: boolean;
  notes: string | null;
}
export interface RepaymentRecordRow { at: string; amount: number; method: string | null; reference: string | null; ledger_backed: boolean; counted: boolean }
export interface MoneyInRow { at: string; category: string; direction: string; amount: number; reference: string | null; group: string; description: string | null; counted: boolean }
export interface AdjustmentRow {
  at: string; kind: string; status: string | null; by: string | null; approved_by?: string | null; reason?: string | null;
  decision_note?: string | null; agent_response?: string | null; old_outstanding?: number | null; new_outstanding?: number | null;
  reduction?: number | null; old_total_repayment?: number | null; new_total_repayment?: number | null;
  old_amount_repaid?: number | null; new_amount_repaid?: number | null; after_funding?: boolean;
}
export interface LedgerRow { at: string; category: string; scope: string; direction: string; amount: number; group: string; reference: string | null; description: string | null }
export interface PlanDetail {
  as_at: string;
  plan: RepaymentPlanRow;
  receipts: ReceiptRow[];
  repayment_records: RepaymentRecordRow[];
  money_in: MoneyInRow[];
  adjustments: AdjustmentRow[];
  ledger: LedgerRow[];
}

/** One readable line for an adjustment: what changed from what to what. */
export function adjustmentChange(a: AdjustmentRow, fmt: (n: number) => string): string {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  if (n(a.old_outstanding) !== null || n(a.new_outstanding) !== null) {
    return `Outstanding ${fmt(n(a.old_outstanding) ?? 0)} to ${fmt(n(a.new_outstanding) ?? 0)}`;
  }
  const parts: string[] = [];
  if (n(a.old_total_repayment) !== n(a.new_total_repayment)) parts.push(`Obligation ${fmt(n(a.old_total_repayment) ?? 0)} to ${fmt(n(a.new_total_repayment) ?? 0)}`);
  if (n(a.old_amount_repaid) !== n(a.new_amount_repaid)) parts.push(`Recorded repaid ${fmt(n(a.old_amount_repaid) ?? 0)} to ${fmt(n(a.new_amount_repaid) ?? 0)}`);
  return parts.join('; ');
}
