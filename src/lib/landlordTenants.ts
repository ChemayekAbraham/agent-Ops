// Display helpers for the Landlord Ops "Tenants" section (one landlord's Rent Plans, from the landlord_tenant_overview function).
//
// The rows, the money and the funding stage all come from the server; nothing here decides a stage or works out a balance.
// The only arithmetic is the total line (a sum of the rows the server returned).

/** One Rent Plan on a landlord, as landlord_tenant_overview returns it. */
export interface LandlordTenantRow {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  rent_amount: number;
  daily_repayment: number;
  total_repayment: number;
  amount_repaid: number;
  balance_left: number;
  plan_status: string;
  funded_at: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  assigned_agent_phone: string | null;
  registering_agent_id: string | null;
  registering_agent_name: string | null;
  funding_stage: string;
}

/** "UGX 1,234,000": whole shillings, thousands separated by commas, always UGX (never the viewer's chosen currency). */
export function formatUgx(n: number | string | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return v < 0 ? `UGX -${digits}` : `UGX ${digits}`;
}

/** International form of a Ugandan number for tel: and wa.me links ("0772 123 456" -> "+256772123456"). */
export function toInternationalPhone(phone: string): string {
  const clean = phone.replace(/[\s()-]/g, '');
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('256')) return `+${clean}`;
  if (clean.startsWith('0')) return `+256${clean.slice(1)}`;
  return `+256${clean}`;
}

/** The plan's status in words ("service_center_review" -> "Service center review"). */
export function planStatusLabel(status: string | null | undefined): string {
  const s = String(status ?? '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
}

export type FundingStageTone = 'review' | 'agent' | 'paid' | 'repaying' | 'completed' | 'closed';

/** The six funding stages the server returns, exactly (the dash is an en dash), and the colour family each is shown in. */
export const FUNDING_STAGE_TONE: Record<string, FundingStageTone> = {
  'In review': 'review',
  'Funded – money with agent': 'agent',
  'Landlord paid': 'paid',
  'Repaying': 'repaying',
  'Completed': 'completed',
  'Rejected/Cancelled': 'closed',
};

export const FUNDING_STAGE_CLASS: Record<FundingStageTone, string> = {
  review: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
  agent: 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200',
  paid: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200',
  repaying: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
  completed: 'border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-500/40 dark:bg-slate-500/10 dark:text-slate-200',
  closed: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200',
};

/** Colour classes for a stage; a value the server may add later still renders (neutral). */
export function fundingStageClass(stage: string): string {
  const tone = FUNDING_STAGE_TONE[stage];
  return tone ? FUNDING_STAGE_CLASS[tone] : 'border-border bg-muted text-foreground';
}

export interface LandlordTenantsTotals {
  /** different tenants across the counted Rent Plans */
  tenants: number;
  /** Rent Plans counted */
  plans: number;
  totalRent: number;
  totalBalance: number;
  /** Rent Plans left out of the totals (rejected or cancelled): they are listed but are not this landlord's tenants */
  excludedPlans: number;
}

/**
 * The total line: tenants, total rent and total balance across the landlord's Rent Plans. Rejected or cancelled plans are still listed,
 * but they are not counted: a plan that never went ahead is not a tenant living in the landlord's house, and it owes nothing.
 */
export function summariseTenants(rows: readonly LandlordTenantRow[]): LandlordTenantsTotals {
  const counted = rows.filter((r) => r.funding_stage !== 'Rejected/Cancelled');
  const tenants = new Set(counted.map((r) => r.tenant_id ?? r.rent_request_id));
  return {
    tenants: tenants.size,
    plans: counted.length,
    totalRent: counted.reduce((s, r) => s + (Number(r.rent_amount) || 0), 0),
    totalBalance: counted.reduce((s, r) => s + (Number(r.balance_left) || 0), 0),
    excludedPlans: rows.length - counted.length,
  };
}

/** One clear sentence for a failed load. */
export function landlordTenantsErrorMessage(err: unknown): string {
  const raw = String((err as { message?: string } | null)?.message ?? err ?? '');
  if (raw.includes('NOT_AUTHORISED')) return "You don't have access to this landlord's tenants. Only Landlord Ops, COO, CFO, CEO and super admin can see them.";
  if (raw.includes('LANDLORD_REQUIRED')) return 'No landlord was chosen.';
  return "We couldn't load this landlord's tenants. Check your connection and try again.";
}
