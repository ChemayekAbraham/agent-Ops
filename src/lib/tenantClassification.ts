/**
 * Tenant classification (Tenant Operations Workspace). Labels and light presentation helpers only:
 * every category, sub-label, count and date comes from `tops_tenant_classification_summary` /
 * `tops_tenant_classification_list`, which read the shared payout clock. Nothing here recomputes a
 * start date or an amount.
 */

export type TenantCategory = 'active' | 'waiting' | 'dormant' | 'inactive';

export type TenantSubLabel =
  | 'renewal_in_progress'
  | 'never_requested'
  | 'request_in_review'
  | 'only_rejected_cancelled'
  | 'other';

export interface TenantClassificationSummary {
  as_of: string;
  population: number;
  active: number;
  waiting: number;
  dormant: number;
  dormant_renewal_in_progress: number;
  inactive: number;
  inactive_never_requested: number;
  inactive_request_in_review: number;
  inactive_only_rejected_cancelled: number;
  inactive_other: number;
  needs_review: number;
}

export interface TenantClassificationRow {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  district: string | null;
  category: TenantCategory;
  sub_label: TenantSubLabel | null;
  needs_review: boolean;
  review_reasons: string | null;
  total_requests: number;
  running_plans: number;
  completed_plans: number;
  outstanding_ugx: number | string;
  completed_on: string | null;
  days_since_completion: number | null;
  latest_status: string | null;
  latest_request_at: string | null;
  latest_agent_name: string | null;
  total_rows: number | string;
}

export const CATEGORY_LABELS: Record<TenantCategory, string> = {
  active: 'Active',
  waiting: 'Waiting for landlord payment',
  dormant: 'Dormant',
  inactive: 'Inactive',
};

export const CATEGORY_HINTS: Record<TenantCategory, string> = {
  active: 'Repaying a Rent Plan the landlord has been paid for',
  waiting: 'Rent Plan funded, landlord not paid yet',
  dormant: 'Finished a Rent Plan, no Rent Plan running',
  inactive: 'Never had a Rent Plan running',
};

export const SUB_LABELS: Record<TenantSubLabel, string> = {
  renewal_in_progress: 'Renewal in progress',
  never_requested: 'Never requested',
  request_in_review: 'Request in review',
  only_rejected_cancelled: 'Only rejected or cancelled requests',
  other: 'Other, check the Rent Plan',
};

/** Sub-labels that exist for each category (Active and Waiting have none). */
export const SUB_LABELS_BY_CATEGORY: Record<TenantCategory, TenantSubLabel[]> = {
  active: [],
  waiting: [],
  dormant: ['renewal_in_progress'],
  inactive: ['never_requested', 'request_in_review', 'only_rejected_cancelled', 'other'],
};

export const CATEGORY_TONE: Record<TenantCategory, string> = {
  active: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  waiting: 'bg-amber-100 text-amber-800 border-amber-200',
  dormant: 'bg-sky-100 text-sky-800 border-sky-200',
  inactive: 'bg-slate-100 text-slate-700 border-slate-200',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as TenantCategory] ?? category;
}

export function subLabelText(sub: string | null | undefined): string | null {
  if (!sub) return null;
  return SUB_LABELS[sub as TenantSubLabel] ?? sub;
}

/** "completed 9 Oct 2026 (4 days ago)" for a Dormant tenant; null for the others. */
export function completionText(row: Pick<TenantClassificationRow, 'completed_on' | 'days_since_completion'>): string | null {
  if (!row.completed_on) return null;
  const d = row.days_since_completion;
  const ago = d == null ? '' : d === 0 ? ' (today)' : d === 1 ? ' (1 day ago)' : ` (${d} days ago)`;
  const [y, m, day] = row.completed_on.slice(0, 10).split('-').map(Number);
  const text = new Date(Date.UTC(y, (m || 1) - 1, day || 1)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  return `${text}${ago}`;
}

export function formatStatus(status: string | null | undefined): string {
  if (!status) return '';
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** The sentence that says which slice of the list is on screen (used by the exports). */
export function filterDescription(category: TenantCategory | null, sub: TenantSubLabel | null, needsReview: boolean, search: string): string {
  const parts = [
    category ? CATEGORY_LABELS[category] : 'All tenants',
    sub ? SUB_LABELS[sub] : null,
    needsReview ? 'Needs review only' : null,
    search.trim() ? `Search "${search.trim()}"` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}
