/**
 * CTO-controlled Rent Plans: types and pure helpers for the collections tracker
 * (`get_cto_controlled_plan_collections`, migration 20261024130000). No money is written here: the numbers come from the database, this
 * file only shapes them for the panel and the PDF.
 */

export interface CtoControlledPlan {
  rentRequestId: string;
  tenantName: string;
  agentId: string | null;
  agentName: string;
  fundedOn: string | null;
  durationDays: number;
  status: string;
  /** rent_amount: what the Rent Plan was given. */
  given: number;
  /** compute_rent_repayment(rent_amount, duration_days).total_repayment */
  formulaDue: number;
  /** rent_requests.amount_repaid */
  recovered: number;
  collectionCount: number;
  lastCollectionOn: string | null;
  /** Ledger split of what came back. */
  partnerEarned: number;
  platformEarned: number;
  agentCommission: number;
  feesDrawn: number;
  principalBack: number;
  expectedPartner: number;
  expectedAgent: number;
  daysOverdue: number;
  /** The sum of the plan's collections is not equal to amount_repaid. */
  counterMismatch: boolean;
  collectionsSum: number;
}

export interface CtoControlledSummary {
  plansCount: number;
  given: number;
  formulaDue: number;
  recovered: number;
  collectionCount: number;
  partnerEarned: number;
  platformEarned: number;
  agentCommission: number;
  feesDrawn: number;
  principalBack: number;
  expectedPartner: number;
  expectedAgent: number;
  anyMismatch: boolean;
}

export interface CtoPlanSearchRow {
  rentRequestId: string;
  tenantName: string;
  tenantPhone: string | null;
  agentName: string;
  status: string;
  rentAmount: number;
  fundedOn: string | null;
  controlled: boolean;
}

export interface CtoAgentRollup {
  agentId: string | null;
  agentName: string;
  plans: number;
  given: number;
  recovered: number;
  agentCommission: number;
}

const n = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));

/** Maps one row of the read function (row_kind 'plan'). */
export function toPlan(r: Record<string, any>): CtoControlledPlan {
  return {
    rentRequestId: String(r.rent_request_id),
    tenantName: r.tenant_name ?? '(no name)',
    agentId: r.agent_id ?? null,
    agentName: r.agent_name ?? '(no agent)',
    fundedOn: r.funded_on ?? null,
    durationDays: n(r.duration_days),
    status: r.status ?? '',
    given: n(r.given),
    formulaDue: n(r.formula_due),
    recovered: n(r.recovered),
    collectionCount: n(r.collection_count),
    lastCollectionOn: r.last_collection_on ?? null,
    partnerEarned: n(r.partner_earned),
    platformEarned: n(r.platform_earned),
    agentCommission: n(r.agent_commission),
    feesDrawn: n(r.fees_drawn),
    principalBack: n(r.principal_back),
    expectedPartner: n(r.expected_partner),
    expectedAgent: n(r.expected_agent),
    daysOverdue: n(r.days_overdue),
    counterMismatch: !!r.counter_mismatch,
    collectionsSum: n(r.collections_sum),
  };
}

/** Maps the summary row (row_kind 'summary'). */
export function toSummary(r: Record<string, any> | undefined): CtoControlledSummary {
  return {
    plansCount: n(r?.plans_count),
    given: n(r?.given),
    formulaDue: n(r?.formula_due),
    recovered: n(r?.recovered),
    collectionCount: n(r?.collection_count),
    partnerEarned: n(r?.partner_earned),
    platformEarned: n(r?.platform_earned),
    agentCommission: n(r?.agent_commission),
    feesDrawn: n(r?.fees_drawn),
    principalBack: n(r?.principal_back),
    expectedPartner: n(r?.expected_partner),
    expectedAgent: n(r?.expected_agent),
    anyMismatch: !!r?.counter_mismatch,
  };
}

export function toSearchRow(r: Record<string, any>): CtoPlanSearchRow {
  return {
    rentRequestId: String(r.rent_request_id),
    tenantName: r.tenant_name ?? '(no name)',
    tenantPhone: r.tenant_phone ?? null,
    agentName: r.agent_name ?? '(no agent)',
    status: r.status ?? '',
    rentAmount: n(r.rent_amount),
    fundedOn: r.funded_on ?? null,
    controlled: !!r.controlled,
  };
}

/** UGX 1,234,567 */
export function fmtUgx(amount: number): string {
  return `UGX ${Math.round(amount || 0).toLocaleString('en-US')}`;
}

/** Percentage of [part] in [whole], one decimal, 0 when there is no whole. */
export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** What is still due on a plan (never negative). */
export const balanceOf = (p: CtoControlledPlan): number => Math.max(0, p.formulaDue - p.recovered);

/** The four shares of what came back, for the stacked bar. principal_back + partner + agent + platform is the recovered cash. */
export function recoveredSplit(s: CtoControlledSummary): { key: 'principal' | 'partner' | 'agent' | 'platform'; label: string; amount: number }[] {
  return [
    { key: 'principal', label: 'Principal back', amount: s.principalBack },
    { key: 'partner', label: 'Partner', amount: s.partnerEarned },
    { key: 'agent', label: 'Agent', amount: s.agentCommission },
    { key: 'platform', label: 'Platform', amount: s.platformEarned },
  ];
}

/** Per-agent roll-up: plans, recovered and agent commission, biggest recovered first. */
export function rollUpByAgent(plans: CtoControlledPlan[]): CtoAgentRollup[] {
  const by = new Map<string, CtoAgentRollup>();
  for (const p of plans) {
    const key = p.agentId ?? p.agentName;
    const row = by.get(key) ?? { agentId: p.agentId, agentName: p.agentName, plans: 0, given: 0, recovered: 0, agentCommission: 0 };
    row.plans += 1;
    row.given += p.given;
    row.recovered += p.recovered;
    row.agentCommission += p.agentCommission;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.recovered - a.recovered || a.agentName.localeCompare(b.agentName));
}

/** Default order: most days overdue first, then the biggest balance still due. */
export function defaultPlanOrder(a: CtoControlledPlan, b: CtoControlledPlan): number {
  return b.daysOverdue - a.daysOverdue || balanceOf(b) - balanceOf(a) || a.tenantName.localeCompare(b.tenantName);
}
