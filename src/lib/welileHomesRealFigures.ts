import { withUuidIds } from '@/lib/isUuid';
/**
 * Welile Homes — real figures behind the Agent Ops Overview money cards.
 *
 * Every number here comes from a recorded fact. Nothing is estimated, annualised or
 * multiplied:
 *   - an application counts as APPROVED only when a review stage has actually approved it
 *     through wh_float_advance (status is past 'pending');
 *   - an application counts as DISBURSED only when the CFO has disbursed it
 *     (wh_cfo_disburse_float sets disbursed_ledger_txn);
 *   - past disbursements Agent Ops entered by hand are kept in their own total and are
 *     never merged into the system total;
 *   - collections and revenue count only rent actually received on tenants whose float
 *     was approved or disbursed, or that carry a manually entered disbursement.
 *
 * Rent that came in on a tenant with no approved float is reported separately and never
 * enters a real total. The enrolled-tenant rent pipeline is a projection and is labelled
 * as such by the screens that show it.
 *
 * This module reads only. It never writes, and it changes no approval, disbursement or
 * ledger rule.
 */
import { supabase } from '@/integrations/supabase/client';
import { fetchWhHistOverview, type WhHistOverview, type WhManualRow, type WhSystemRow } from '@/lib/welileHomesHistorical';

/** Statuses that mean a review stage has approved the request (server-set by wh_float_advance). */
const APPROVED_STATUSES = new Set([
  'agent_ops_approved',
  'tenant_ops_approved',
  'landlord_ops_approved',
  'coo_approved',
  'approved',
]);

/** Plain-English stage name for an approved application, for breakdown lists. */
const STATUS_LABEL: Record<string, string> = {
  agent_ops_approved: 'Agent Ops approved',
  tenant_ops_approved: 'Tenant Ops approved',
  landlord_ops_approved: 'Landlord Ops approved',
  coo_approved: 'COO approved',
  approved: 'Disbursed by the CFO',
};

export function whApplicationLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export interface WhApplicationRow {
  id: string;
  agent_id: string;
  agent_name: string;
  amount: number;
  status: string;
  created_at: string;
  approved_at: string | null;
  tenant_count: number;
  subscription_ids: string[];
  disbursed: boolean;
}

export interface WhCollectionRow {
  id: string;
  subscription_id: string;
  tenant_id: string;
  agent_id: string | null;
  period_month: string;
  amount_collected: number;
  welile_net: number;
  landlord_net: number;
  collection_status: string;
  payout_status: string;
}

export interface WhRealFigures {
  /** Applications approved through the flow, newest first. Includes the disbursed ones. */
  approved: WhApplicationRow[];
  /** Of those, the ones the CFO has disbursed. */
  disbursed: WhApplicationRow[];
  approvedTotal: number;
  disbursedTotal: number;
  /** Approved but not yet disbursed. */
  awaitingDisbursementTotal: number;
  /** Past disbursements Agent Ops entered by hand, after reversals. */
  manualTotal: number;
  manualCount: number;
  manualRows: WhManualRow[];
  /** System-recorded (CFO disbursed) total straight from the historical RPC. */
  systemTotal: number;
  systemRows: WhSystemRow[];
  /** Rent actually received on tenants with approved / disbursed / manually funded float. */
  collectionsTotal: number;
  collectionsMtd: number;
  welileNetTotal: number;
  pendingPayoutsTotal: number;
  collectionRows: WhCollectionRow[];
  /** Rent actually received on tenants with no approved float — shown, never counted. */
  unapprovedCollectionsTotal: number;
  unapprovedCollectionRows: WhCollectionRow[];
  /** Subscriptions covered by a real float fact (approved, disbursed or manually entered). */
  coveredSubscriptionIds: Set<string>;
  /** False while nothing has been approved: the screens then show UGX 0 + "No approved float yet". */
  hasApprovedFloat: boolean;
  /** True when a read failed, so the screens must not present the totals as complete. */
  incomplete: boolean;
}

const EMPTY: WhRealFigures = {
  approved: [],
  disbursed: [],
  approvedTotal: 0,
  disbursedTotal: 0,
  awaitingDisbursementTotal: 0,
  manualTotal: 0,
  manualCount: 0,
  manualRows: [],
  systemTotal: 0,
  systemRows: [],
  collectionsTotal: 0,
  collectionsMtd: 0,
  welileNetTotal: 0,
  pendingPayoutsTotal: 0,
  collectionRows: [],
  unapprovedCollectionsTotal: 0,
  unapprovedCollectionRows: [],
  coveredSubscriptionIds: new Set(),
  hasApprovedFloat: false,
  incomplete: false,
};

/** Kampala calendar month key (YYYY-MM) for the current month. */
export function kampalaMonthKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit',
  }).format(now);
}

export interface WhApplicationSource {
  id: string;
  agent_id: string;
  requested_amount: number | string | null;
  approved_amount?: number | string | null;
  status: string | null;
  created_at: string;
  approved_at?: string | null;
  disbursed_ledger_txn?: string | null;
}

/**
 * Approved / disbursed applications from the recorded request rows.
 * Pure so the stage rule can be tested without a database.
 */
export function applicationsFromRequests(
  requests: WhApplicationSource[],
  itemsByRequest: Map<string, string[]>,
  agentNames: Map<string, string>,
): WhApplicationRow[] {
  return requests
    .filter((r) => typeof r.status === 'string' && APPROVED_STATUSES.has(r.status))
    .map((r) => {
      const subscriptionIds = itemsByRequest.get(r.id) ?? [];
      return {
        id: r.id,
        agent_id: r.agent_id,
        agent_name: agentNames.get(r.agent_id) ?? 'Agent',
        amount: Number(r.approved_amount ?? r.requested_amount ?? 0) || 0,
        status: String(r.status),
        created_at: r.created_at,
        approved_at: r.approved_at ?? null,
        tenant_count: subscriptionIds.length,
        subscription_ids: subscriptionIds,
        disbursed: !!r.disbursed_ledger_txn || r.status === 'approved',
      };
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** Rent actually received, split by whether the tenant's float was really funded. */
export function splitCollections(
  dues: WhCollectionRow[],
  coveredSubscriptionIds: Set<string>,
  monthKey: string,
): {
  collectionsTotal: number; collectionsMtd: number; welileNetTotal: number;
  pendingPayoutsTotal: number; collectionRows: WhCollectionRow[];
  unapprovedCollectionsTotal: number; unapprovedCollectionRows: WhCollectionRow[];
} {
  let collectionsTotal = 0, collectionsMtd = 0, welileNetTotal = 0, pendingPayoutsTotal = 0;
  let unapprovedCollectionsTotal = 0;
  const collectionRows: WhCollectionRow[] = [];
  const unapprovedCollectionRows: WhCollectionRow[] = [];

  for (const d of dues) {
    const collected = Number(d.amount_collected) || 0;
    if (collected <= 0 && d.collection_status !== 'collected') continue;
    if (coveredSubscriptionIds.has(d.subscription_id)) {
      collectionsTotal += collected;
      if (String(d.period_month).slice(0, 7) === monthKey) collectionsMtd += collected;
      if (d.collection_status === 'collected') {
        welileNetTotal += Number(d.welile_net) || 0;
        if (d.payout_status === 'unpaid') pendingPayoutsTotal += Number(d.landlord_net) || 0;
      }
      collectionRows.push(d);
    } else {
      unapprovedCollectionsTotal += collected;
      unapprovedCollectionRows.push(d);
    }
  }

  return {
    collectionsTotal, collectionsMtd, welileNetTotal, pendingPayoutsTotal, collectionRows,
    unapprovedCollectionsTotal, unapprovedCollectionRows,
  };
}

/**
 * Loads every real figure behind the Overview money cards.
 * Any failed read is reported through `incomplete` instead of being silently dropped.
 */
export async function fetchWhRealFigures(): Promise<WhRealFigures> {
  let incomplete = false;

  const [requestsRes, itemsRes, histRes] = await Promise.all([
    (supabase.from as any)('float_requests')
      .select('id, agent_id, requested_amount, approved_amount, status, created_at, approved_at, disbursed_ledger_txn')
      .eq('product', 'welile_homes')
      .order('created_at', { ascending: false })
      .limit(2000),
    (supabase.from as any)('welile_homes_float_request_items')
      .select('float_request_id, subscription_id')
      .order('created_at', { ascending: false })
      .limit(5000),
    fetchWhHistOverview().catch((err) => {
      console.warn('Welile Homes historical read failed:', err);
      incomplete = true;
      return null as WhHistOverview | null;
    }),
  ]);

  if (requestsRes.error) {
    console.warn('Welile Homes float applications read failed:', requestsRes.error.message);
    incomplete = true;
  }
  if (itemsRes.error) {
    console.warn('Welile Homes float tenant links read failed:', itemsRes.error.message);
    incomplete = true;
  }

  const requests = (requestsRes.data ?? []) as WhApplicationSource[];
  const itemsByRequest = new Map<string, string[]>();
  for (const it of (itemsRes.data ?? []) as { float_request_id: string; subscription_id: string }[]) {
    if (!it.float_request_id || !it.subscription_id) continue;
    const list = itemsByRequest.get(it.float_request_id) ?? [];
    list.push(it.subscription_id);
    itemsByRequest.set(it.float_request_id, list);
  }

  const agentIds = Array.from(new Set(requests.map((r) => r.agent_id).filter(Boolean)));
  const agentNames = new Map<string, string>();
  if (agentIds.length) {
    const { data: profs } = await withUuidIds(agentIds, (validIds) => supabase.from('profiles').select('id, full_name').in('id', validIds));
    for (const p of (profs ?? []) as { id: string; full_name: string | null }[]) {
      agentNames.set(p.id, p.full_name ?? 'Agent');
    }
  }

  const approved = applicationsFromRequests(requests, itemsByRequest, agentNames);
  const disbursed = approved.filter((a) => a.disbursed);
  const approvedTotal = approved.reduce((s, a) => s + a.amount, 0);
  const disbursedTotal = disbursed.reduce((s, a) => s + a.amount, 0);

  const hist = histRes;
  const manualRows = hist?.manual.filter((m) => !m.reversed) ?? [];
  const manualTotal = hist?.manual_total ?? 0;
  const manualCount = hist?.manual_count ?? 0;
  const systemTotal = hist?.system_total ?? 0;
  const systemRows = hist?.system ?? [];

  const coveredSubscriptionIds = new Set<string>();
  for (const a of approved) a.subscription_ids.forEach((s) => coveredSubscriptionIds.add(s));
  for (const m of manualRows) if (m.subscription_id) coveredSubscriptionIds.add(m.subscription_id);

  // Rent actually received. Read completely: a short page would understate collections.
  const dues: WhCollectionRow[] = [];
  const PAGE = 1000;
  try {
    for (let page = 0; page < 50; page++) {
      const { data, error } = await supabase
        .from('welile_homes_monthly_dues')
        .select('id, subscription_id, tenant_id, agent_id, period_month, amount_collected, welile_net, landlord_net, collection_status, payout_status')
        .or('amount_collected.gt.0,collection_status.eq.collected')
        .order('id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as WhCollectionRow[];
      dues.push(...rows);
      if (!data || data.length < PAGE) break;
      if (page === 49) {
        console.warn('Welile Homes collections read hit the page cap; totals may be short.');
        incomplete = true;
      }
    }
  } catch (err) {
    console.warn('Welile Homes collections read failed:', err);
    incomplete = true;
  }

  const split = splitCollections(dues, coveredSubscriptionIds, kampalaMonthKey());

  return {
    ...EMPTY,
    approved,
    disbursed,
    approvedTotal,
    disbursedTotal,
    awaitingDisbursementTotal: Math.max(0, approvedTotal - disbursedTotal),
    manualTotal,
    manualCount,
    manualRows,
    systemTotal,
    systemRows,
    ...split,
    coveredSubscriptionIds,
    hasApprovedFloat: approvedTotal > 0 || manualTotal > 0,
    incomplete,
  };
}
