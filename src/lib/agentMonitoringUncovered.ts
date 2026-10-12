/**
 * Agent Monitoring: Rent Plans the landlord-payout clock does not cover.
 *
 * Two lists sit beside the main tab:
 *   - `tenant_paying_no_landlord`: the tenant has been repaying but the landlord has no counted
 *     payout yet, so there is no clock to measure arrears from;
 *   - `awaiting_landlord`: funded, nothing paid by the tenant, landlord not paid.
 * This file holds only the pure presentation logic (payout wording, days, search, sort,
 * paging, totals). Nothing here writes data.
 */

export type UncoveredBucket = 'tenant_paying_no_landlord' | 'awaiting_landlord';

/** Where the landlord payout stands for a Rent Plan the clock does not cover. */
export type PayoutKind = 'none' | 'pending' | 'failed' | 'part_paid' | 'paid_unrecorded';

export interface PayoutState {
  kind: PayoutKind;
  /** UGX already paid out of the float for this plan (part-paid and paid_unrecorded). */
  paidAmount: number;
  /** UGX allocated to the landlord, when there is an allocation. */
  allocatedAmount: number;
}

export interface PayoutRowInput {
  status: string;
  amount: number | null;
}

export interface AllocationRowInput {
  status: string;
  allocated_amount: number | null;
  paid_out_amount: number | null;
}

export interface UncoveredPlanRow {
  id: string;
  bucket: UncoveredBucket;
  tenantId: string;
  tenantName: string;
  tenantPhone: string | null;
  agentId: string | null;
  agentName: string;
  /** Rent Plan amount funded (`rent_amount`). */
  fundedAmount: number;
  totalRepayment: number;
  repaid: number;
  stillOwed: number;
  /** Day the plan was funded (Kampala yyyy-MM-dd); falls back to disbursed, then created. */
  fundedOn: string | null;
  daysSinceFunding: number | null;
  payout: PayoutState;
  pipelineStatus: string;
}

/** Payout rows in these statuses mean a payout is under way, not paid. */
const PENDING_PAYOUT_STATUSES = [
  'otp_verified',
  'pending_finops_disbursement',
  'pending_merchant_payout',
  'disbursing',
  'escalated',
];

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * One state per plan, from its payout rows and its float allocations.
 * Counted-paid payouts (`awaiting_agent_receipt`, `completed`) cannot appear here, because a
 * plan with one is on the clock. A paid-out float allocation with no payout record is shown
 * as `paid_unrecorded` so the gap is visible instead of reading as "nothing paid".
 */
export function summarisePayouts(
  payouts: readonly PayoutRowInput[],
  allocations: readonly AllocationRowInput[],
): PayoutState {
  const live = allocations.filter((a) => a.status !== 'cancelled');
  const paidAmount = live.reduce((sum, a) => sum + num(a.paid_out_amount), 0);
  const allocatedAmount = live.reduce((sum, a) => sum + num(a.allocated_amount), 0);

  if (paidAmount > 0) {
    const full = live.some((a) => a.status === 'fully_paid') && paidAmount >= allocatedAmount;
    const recorded = payouts.some((p) => ['awaiting_agent_receipt', 'completed'].includes(p.status));
    return {
      kind: full && !recorded ? 'paid_unrecorded' : 'part_paid',
      paidAmount,
      allocatedAmount,
    };
  }
  if (payouts.some((p) => PENDING_PAYOUT_STATUSES.includes(p.status))) {
    return { kind: 'pending', paidAmount: 0, allocatedAmount };
  }
  if (payouts.length > 0 && payouts.every((p) => p.status === 'failed')) {
    return { kind: 'failed', paidAmount: 0, allocatedAmount };
  }
  return { kind: 'none', paidAmount: 0, allocatedAmount };
}

/** Whole days from a Kampala calendar day to `today` (both yyyy-MM-dd). Null when unknown. */
export function daysBetweenYmd(from: string | null, today: string): number | null {
  if (!from) return null;
  const [fy, fm, fd] = from.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = today.slice(0, 10).split('-').map(Number);
  if (![fy, fm, fd, ty, tm, td].every(Number.isFinite)) return null;
  return Math.max(0, Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000));
}

export function formatPipelineStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Plain-language payout wording; `fmt` formats UGX (the page passes `formatUGX`). */
export function describePayout(state: PayoutState, fmt: (n: number) => string): string {
  switch (state.kind) {
    case 'pending':
      return 'Payout pending';
    case 'failed':
      return 'Payout failed';
    case 'part_paid':
      return state.allocatedAmount > 0
        ? `Part-paid ${fmt(state.paidAmount)} of ${fmt(state.allocatedAmount)}`
        : `Part-paid ${fmt(state.paidAmount)}`;
    case 'paid_unrecorded':
      return `Float paid ${fmt(state.paidAmount)}, no payout record`;
    default:
      return 'No payout';
  }
}

export type UncoveredSortKey =
  | 'repaid_desc'
  | 'repaid_asc'
  | 'days_desc'
  | 'funded_desc'
  | 'name_asc';

export interface UncoveredFilter {
  search: string;
  /** Agent id, or 'all'. */
  agentId: string;
}

export function filterUncovered(rows: readonly UncoveredPlanRow[], filter: UncoveredFilter): UncoveredPlanRow[] {
  const query = filter.search.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  return rows.filter((row) => {
    if (filter.agentId !== 'all' && row.agentId !== filter.agentId) return false;
    if (!query) return true;
    const haystack = `${row.tenantName} ${row.agentName}`.toLowerCase();
    if (haystack.includes(query)) return true;
    // Phone numbers are matched on digits so "0701 234" finds "+256701234567".
    return digits.length >= 3 && (row.tenantPhone ?? '').replace(/\D/g, '').includes(digits);
  });
}

export function sortUncovered(rows: readonly UncoveredPlanRow[], key: UncoveredSortKey): UncoveredPlanRow[] {
  const copy = [...rows];
  const days = (row: UncoveredPlanRow) => row.daysSinceFunding ?? -1;
  copy.sort((a, b) => {
    switch (key) {
      case 'repaid_asc': return a.repaid - b.repaid || a.tenantName.localeCompare(b.tenantName);
      case 'days_desc': return days(b) - days(a) || a.tenantName.localeCompare(b.tenantName);
      case 'funded_desc': return b.fundedAmount - a.fundedAmount || a.tenantName.localeCompare(b.tenantName);
      case 'name_asc': return a.tenantName.localeCompare(b.tenantName);
      default: return b.repaid - a.repaid || a.tenantName.localeCompare(b.tenantName);
    }
  });
  return copy;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
}

/** 1-based page, clamped into range. */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): Page<T> {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  return { items: rows.slice((current - 1) * pageSize, current * pageSize), page: current, pageCount, total };
}

export interface UncoveredSummary {
  plans: number;
  totalFunded: number;
  totalRepaid: number;
  totalOwed: number;
  /** Longest wait since funding, in days (null when no plan has a funding date). */
  longestDays: number | null;
}

export function summariseUncovered(rows: readonly UncoveredPlanRow[]): UncoveredSummary {
  const dayValues = rows.map((r) => r.daysSinceFunding).filter((d): d is number => d !== null);
  return {
    plans: rows.length,
    totalFunded: rows.reduce((s, r) => s + r.fundedAmount, 0),
    totalRepaid: rows.reduce((s, r) => s + r.repaid, 0),
    totalOwed: rows.reduce((s, r) => s + r.stillOwed, 0),
    longestDays: dayValues.length ? Math.max(...dayValues) : null,
  };
}

/** Distinct agents in the list, for the agent filter, busiest first. */
export function agentOptions(rows: readonly UncoveredPlanRow[]): { id: string; name: string; count: number }[] {
  const map = new Map<string, { id: string; name: string; count: number }>();
  rows.forEach((row) => {
    if (!row.agentId) return;
    const entry = map.get(row.agentId) ?? { id: row.agentId, name: row.agentName, count: 0 };
    entry.count += 1;
    map.set(row.agentId, entry);
  });
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
