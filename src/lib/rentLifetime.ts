// Types and small pure helpers for the two all-time rent request cards of the Tenant Ops summary.
//
// Every count and amount comes from one server function, tenant_ops_rent_request_lifetime(), which takes no dates. Nothing here adds up,
// classifies or re-derives a figure: normalizeLifetime only types the answer (a missing figure reads as 0), pct() turns a part and a whole the
// server returned into a display percentage, and stagePassRate() compares two funnel rows for display. classifyRepayment() mirrors the SQL rule
// for the tests only; the screen never calls it.

export const FUNNEL_STAGES = ['service_center', 'agent_ops', 'tenant_ops', 'landlord_ops', 'partner_ops', 'coo', 'funded', 'financed'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_LABEL: Record<FunnelStage, string> = {
  service_center: 'Service Centre check',
  agent_ops: 'Agent Ops approval',
  tenant_ops: 'Tenant Ops approval',
  landlord_ops: 'Landlord Ops approval',
  partner_ops: 'Partner Ops approval',
  coo: 'Executive approval',
  funded: 'Funded',
  financed: 'Financed (landlord paid)',
};

export interface FunnelRow { stage: FunnelStage; count: number }

export interface RentLifetime {
  as_at: string;
  basis: string;
  submitted: number;
  stage_funnel: FunnelRow[];
  outcomes: { waiting_service_centre: number; pending: number; rejected: number; deleted_by_agent: number; cancelled: number };
  funded: number;
  financed: number;
  repayment: { full: number; partial: number; never_paid: number; too_early: number };
  financed_now_closed: number;
  funded_not_financed: number;
  money: { total_repayment: number; amount_repaid: number };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The server's answer as a typed value. A missing figure reads as 0; the funnel always has the eight rows in pipeline order. */
export function normalizeLifetime(raw: unknown): RentLifetime {
  const r = obj(Array.isArray(raw) ? raw[0] : raw);
  const o = obj(r.outcomes);
  const rep = obj(r.repayment);
  const m = obj(r.money);
  const rows = Array.isArray(r.stage_funnel) ? (r.stage_funnel as unknown[]).map(obj) : [];
  return {
    as_at: String(r.as_at ?? ''),
    basis: String(r.basis ?? ''),
    submitted: num(r.submitted),
    stage_funnel: FUNNEL_STAGES.map((stage) => ({ stage, count: num(rows.find((x) => x.stage === stage)?.count) })),
    outcomes: {
      waiting_service_centre: num(o.waiting_service_centre), pending: num(o.pending), rejected: num(o.rejected),
      deleted_by_agent: num(o.deleted_by_agent), cancelled: num(o.cancelled),
    },
    funded: num(r.funded),
    financed: num(r.financed),
    repayment: { full: num(rep.full), partial: num(rep.partial), never_paid: num(rep.never_paid), too_early: num(rep.too_early) },
    financed_now_closed: num(r.financed_now_closed),
    funded_not_financed: num(r.funded_not_financed),
    money: { total_repayment: num(m.total_repayment), amount_repaid: num(m.amount_repaid) },
  };
}

/** part as a percentage of whole, one decimal; 0 when the whole is 0 (or either is not a finite number). */
export function pct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Pass rate of funnel row `index` against the row before it; the first row is compared with `submitted`. */
export function stagePassRate(rows: FunnelRow[], index: number, submitted: number): number {
  if (index < 0 || index >= rows.length) return 0;
  const previous = index === 0 ? submitted : rows[index - 1].count;
  return pct(rows[index].count, previous);
}

export type RepaymentBucket = 'full' | 'partial' | 'never_paid' | 'too_early';

export const NEVER_PAID_AFTER_DAYS = 30;

/**
 * The repayment rule of the SQL function, for tests only (the screen shows the server's buckets).
 * full: status completed, or total_repayment > 0 and amount_repaid >= total_repayment; partial: amount_repaid > 0 and not full;
 * never_paid: nothing repaid and the landlord was paid more than 30 days ago; too_early: nothing repaid, 30 days ago or less.
 */
export function classifyRepayment(
  f: { status: string; total_repayment: number; amount_repaid: number; landlord_paid_at: Date },
  now: Date = new Date(),
): RepaymentBucket {
  const total = f.total_repayment || 0;
  const repaid = f.amount_repaid || 0;
  if (f.status === 'completed' || (total > 0 && repaid >= total)) return 'full';
  if (repaid > 0) return 'partial';
  const cutoff = now.getTime() - NEVER_PAID_AFTER_DAYS * 86_400_000;
  return f.landlord_paid_at.getTime() < cutoff ? 'never_paid' : 'too_early';
}
