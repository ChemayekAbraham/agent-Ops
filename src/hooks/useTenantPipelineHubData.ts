import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Read-only data source for the Tenant Ops → Pipeline Status Hub.
 *
 * Pulls the rent-request pipeline that ALREADY exists in the system plus the
 * collection (receivables) and landlord-payout (payables) records that hang off
 * it. No writes, no approvals, no derived statuses — statuses come straight
 * from rent_requests.status.
 */

export interface PipelineRequestRow {
  id: string;
  status: string;
  tenancy_status: string | null;
  registration_type: string | null;
  rent_amount: number;
  daily_repayment: number;
  duration_days: number | null;
  total_repayment: number;
  amount_repaid: number;
  access_fee: number;
  request_fee: number;
  outstanding: number;
  created_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  funded_at: string | null;
  disbursed_at: string | null;
  resubmitted_at: string | null;
  returned_at: string | null;
  rejected_reason: string | null;
  rejected_at_stage: string | null;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string;
  agent_id: string | null;
  agent_name: string;
  landlord_id: string | null;
  landlord_name: string;
  landlord_phone: string;
  house_listing_id: string | null;
  house_title: string;
  house_address: string;
  district: string;
  village: string;
  /** collections attributed to this request inside the loaded window */
  search_text: string;
}

export interface PipelineCollectionRow {
  id: string;
  amount: number;
  created_at: string;
  tenant_id: string | null;
  agent_id: string | null;
  rent_request_id: string | null;
  payment_method: string | null;
}

export interface PipelinePayoutRow {
  id: string;
  amount: number;
  created_at: string;
  status: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  tenant_id: string | null;
  rent_request_id: string | null;
  mobile_money_provider: string | null;
}

export interface PipelineHubData {
  requests: PipelineRequestRow[];
  collections: PipelineCollectionRow[];
  payouts: PipelinePayoutRow[];
}

const PAGE = 1000;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
    if (from > 60000) break;
  }
  return out;
}

async function fetchInBatches<T>(
  ids: string[],
  fn: (batch: string[]) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await fn(ids.slice(i, i + 500));
    if (data) out.push(...data);
  }
  return out;
}

const num = (v: any) => Number(v || 0);

export function useTenantPipelineHubData(historyDays = 400) {
  return useQuery<PipelineHubData>({
    queryKey: ['tenant-pipeline-hub', historyDays],
    staleTime: 300000,
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - historyDays);
      const sinceIso = since.toISOString();

      const [rawRequests, rawCollections, rawPayouts, rawLedgerPayouts] = await Promise.all([
        pageAll<any>((from, to) =>
          supabase
            .from('rent_requests')
            .select(
              'id, status, tenancy_status, registration_type, rent_amount, daily_repayment, duration_days, total_repayment, amount_repaid, access_fee, request_fee, created_at, approved_at, rejected_at, funded_at, disbursed_at, resubmitted_at, returned_at, rejected_reason, rejected_at_stage, tenant_id, agent_id, assigned_agent_id, landlord_id, house_listing_id, request_city',
            )
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        pageAll<any>((from, to) =>
          supabase
            .from('agent_collections')
            .select('id, amount, created_at, tenant_id, agent_id, rent_request_id, payment_method').is('reversed_at', null)
            .gte('created_at', sinceIso)
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        pageAll<any>((from, to) =>
          supabase
            .from('agent_landlord_payouts')
            .select('id, amount, created_at, status, landlord_id, landlord_name, tenant_id, rent_request_id, mobile_money_provider')
            .gte('created_at', sinceIso)
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        // Landlord money actually released through the ledger. agent_landlord_payouts
        // only holds agent-executed payouts; the CFO/float disbursement path posts
        // `rent_disbursement` platform legs instead, so both must be counted.
        pageAll<any>((from, to) =>
          supabase
            .from('general_ledger')
            .select('id, amount, created_at, description, linked_party, source_id, source_table')
            .eq('category', 'rent_disbursement')
            .eq('ledger_scope', 'platform')
            .eq('direction', 'cash_out')
            .neq('classification', 'admin_correction')
            .gte('created_at', sinceIso)
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
      ]);

      const tenantIds = [...new Set(rawRequests.map((r) => r.tenant_id).filter(Boolean))] as string[];
      const agentIds = [
        ...new Set(
          rawRequests
            .flatMap((r) => [r.agent_id, r.assigned_agent_id])
            .concat(rawCollections.map((c) => c.agent_id))
            .filter(Boolean),
        ),
      ] as string[];
      const landlordIds = [...new Set(rawRequests.map((r) => r.landlord_id).filter(Boolean))] as string[];
      const houseIds = [...new Set(rawRequests.map((r) => r.house_listing_id).filter(Boolean))] as string[];

      const [tenants, agents, landlords, houses] = await Promise.all([
        fetchInBatches<any>(tenantIds, (b) =>
          supabase.from('profiles').select('id, full_name, phone').in('id', b),
        ),
        fetchInBatches<any>(agentIds, (b) =>
          supabase.from('profiles').select('id, full_name, phone').in('id', b),
        ),
        fetchInBatches<any>(landlordIds, (b) =>
          supabase.from('landlords').select('id, name, phone').in('id', b),
        ),
        fetchInBatches<any>(houseIds, (b) =>
          supabase
            .from('house_listings')
            .select('id, title, address, district, village, region')
            .in('id', b),
        ),
      ]);

      const tenantMap = new Map(tenants.map((t) => [t.id, t]));
      const agentMap = new Map(agents.map((a) => [a.id, a]));
      const landlordMap = new Map(landlords.map((l) => [l.id, l]));
      const houseMap = new Map(houses.map((h) => [h.id, h]));

      const requests: PipelineRequestRow[] = rawRequests.map((r) => {
        const tenant = r.tenant_id ? tenantMap.get(r.tenant_id) : null;
        const agentId = r.agent_id || r.assigned_agent_id || null;
        const agent = agentId ? agentMap.get(agentId) : null;
        const landlord = r.landlord_id ? landlordMap.get(r.landlord_id) : null;
        const house = r.house_listing_id ? houseMap.get(r.house_listing_id) : null;
        const total = num(r.total_repayment);
        const repaid = num(r.amount_repaid);
        const row: PipelineRequestRow = {
          id: r.id,
          status: r.status,
          tenancy_status: r.tenancy_status ?? null,
          registration_type: r.registration_type ?? null,
          rent_amount: num(r.rent_amount),
          daily_repayment: num(r.daily_repayment),
          duration_days: r.duration_days ?? null,
          total_repayment: total,
          amount_repaid: repaid,
          access_fee: num(r.access_fee),
          request_fee: num(r.request_fee),
          outstanding: Math.max(0, total - repaid),
          created_at: r.created_at ?? null,
          approved_at: r.approved_at ?? null,
          rejected_at: r.rejected_at ?? null,
          funded_at: r.funded_at ?? null,
          disbursed_at: r.disbursed_at ?? null,
          resubmitted_at: r.resubmitted_at ?? null,
          returned_at: r.returned_at ?? null,
          rejected_reason: r.rejected_reason ?? null,
          rejected_at_stage: r.rejected_at_stage ?? null,
          tenant_id: r.tenant_id ?? null,
          tenant_name: tenant?.full_name || '—',
          tenant_phone: tenant?.phone || '—',
          agent_id: agentId,
          agent_name: agent?.full_name || 'Unassigned',
          landlord_id: r.landlord_id ?? null,
          landlord_name: landlord?.name || '—',
          landlord_phone: landlord?.phone || '—',
          house_listing_id: r.house_listing_id ?? null,
          house_title: house?.title || '—',
          house_address: house?.address || '—',
          district: house?.district || r.request_city || '—',
          village: house?.village || '—',
          search_text: '',
        };
        row.search_text = [
          row.tenant_name,
          row.tenant_phone,
          row.agent_name,
          row.landlord_name,
          row.landlord_phone,
          row.house_title,
          row.house_address,
          row.district,
          row.village,
          row.status,
        ]
          .join(' ')
          .toLowerCase();
        return row;
      });

      const collections: PipelineCollectionRow[] = rawCollections.map((c) => ({
        id: c.id,
        amount: num(c.amount),
        created_at: c.created_at,
        tenant_id: c.tenant_id ?? null,
        agent_id: c.agent_id ?? null,
        rent_request_id: c.rent_request_id ?? null,
        payment_method: c.payment_method ?? null,
      }));

      const payouts: PipelinePayoutRow[] = rawPayouts.map((p) => ({
        id: p.id,
        amount: num(p.amount),
        created_at: p.created_at,
        status: p.status ?? null,
        landlord_id: p.landlord_id ?? null,
        landlord_name: p.landlord_name ?? null,
        tenant_id: p.tenant_id ?? null,
        rent_request_id: p.rent_request_id ?? null,
        mobile_money_provider: p.mobile_money_provider ?? null,
      }));

      // Ledger-recorded landlord disbursements, mapped onto the same shape.
      const requestById = new Map(requests.map((r) => [r.id, r]));
      rawLedgerPayouts.forEach((g: any) => {
        const req = g.source_table === 'rent_requests' && g.source_id ? requestById.get(g.source_id) : undefined;
        payouts.push({
          id: `gl-${g.id}`,
          amount: num(g.amount),
          created_at: g.created_at,
          status: 'ledger_posted',
          landlord_id: req?.landlord_id ?? null,
          landlord_name: req?.landlord_name || (typeof g.description === 'string' ? (g.description.match(/landlord ([^.]+)\./i)?.[1] ?? null) : null),
          tenant_id: req?.tenant_id ?? null,
          rent_request_id: req?.id ?? (g.source_table === 'rent_requests' ? g.source_id : null),
          mobile_money_provider: null,
        });
      });

      return { requests, collections, payouts };
    },
  });
}

/** Canonical pipeline statuses, taken from the rent_requests status check. */
export const PIPELINE_STATUS_GROUPS: {
  key: string;
  label: string;
  statuses: string[];
  tone: string;
}[] = [
  { key: 'all', label: 'All', statuses: [], tone: 'bg-muted text-foreground' },
  { key: 'pending', label: 'Pending', statuses: ['pending', 'service_center_review'], tone: 'bg-amber-500/10 text-amber-600' },
  {
    key: 'in_pipeline',
    label: 'In pipeline',
    statuses: ['agent_ops_approved', 'tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'coo_approved'],
    tone: 'bg-blue-500/10 text-blue-600',
  },
  { key: 'approved', label: 'Approved', statuses: ['approved'], tone: 'bg-sky-500/10 text-sky-600' },
  { key: 'funded', label: 'Funded', statuses: ['funded', 'disbursed'], tone: 'bg-green-500/10 text-green-600' },
  { key: 'repaying', label: 'Repaying', statuses: ['repaying'], tone: 'bg-purple-500/10 text-purple-600' },
  { key: 'completed', label: 'Completed', statuses: ['fully_repaid', 'completed'], tone: 'bg-emerald-500/10 text-emerald-600' },
  { key: 'defaulted', label: 'Defaulted', statuses: ['defaulted'], tone: 'bg-destructive/10 text-destructive' },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'], tone: 'bg-rose-500/10 text-rose-600' },
  {
    key: 'cancelled',
    label: 'Cancelled / Withdrawn',
    statuses: ['cancelled', 'deleted_by_agent'],
    tone: 'bg-slate-500/10 text-slate-600',
  },
];

export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  service_center_review: 'Service centre review',
  approved: 'Approved',
  agent_ops_approved: 'Agent Ops approved',
  tenant_ops_approved: 'Tenant Ops approved',
  agent_verified: 'Agent verified',
  landlord_ops_approved: 'Landlord Ops approved',
  coo_approved: 'COO approved',
  funded: 'Funded',
  disbursed: 'Disbursed',
  repaying: 'Repaying',
  fully_repaid: 'Fully repaid',
  completed: 'Completed',
  defaulted: 'Defaulted',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  deleted_by_agent: 'Withdrawn by agent',
};