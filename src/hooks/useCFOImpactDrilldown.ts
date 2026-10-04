import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ImpactMetric = 'users' | 'tenants' | 'agents' | 'partners' | 'landlords_active' | 'landlords_dormant';

export interface DrilldownRecord {
  id: string;
  name: string;
  phone: string | null;
  amount?: number;
  date: string;
  meta?: string;
}

export interface DrilldownResult {
  records: DrilldownRecord[];
  total: number;
  truncated: boolean;
  /** All distinct regions in the underlying data, for populating filter chips. */
  regions?: string[];
}

export interface LandlordFilters {
  /** Free-text search against property_address / house_number / district */
  property?: string;
  /** Exact region match (e.g. "Central", "Western") */
  region?: string;
  /** Account status: verified, unverified, ready (ready_to_receive=true), not_ready */
  accountStatus?: 'all' | 'verified' | 'unverified' | 'ready' | 'not_ready';
}

const PAGE_SIZE = 200;

/**
 * Loads underlying records behind each CFO Impact KPI, optionally
 * scoped to a date range. All queries are read-only and capped at 200 rows.
 */
export function useCFOImpactDrilldown(
  metric: ImpactMetric | null,
  from: Date | undefined,
  to: Date | undefined,
  enabled: boolean,
  landlordFilters?: LandlordFilters,
) {
  return useQuery<DrilldownResult>({
    queryKey: [
      'cfo-impact-drilldown',
      metric,
      from?.toISOString() ?? null,
      to?.toISOString() ?? null,
      landlordFilters?.property ?? null,
      landlordFilters?.region ?? null,
      landlordFilters?.accountStatus ?? null,
    ],
    enabled: enabled && !!metric,
    staleTime: 60 * 1000,
    queryFn: async () => {
      if (!metric) return { records: [], total: 0, truncated: false };
      const fromIso = from ? from.toISOString() : null;
      const toIso = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString() : null;

      if (metric === 'users') {
        let q = supabase
          .from('profiles')
          .select('id, full_name, phone, created_at', { count: 'exact' })
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso) q = q.lte('created_at', toIso);
        const { data, count, error } = await q;
        if (error) throw error;
        return {
          records: (data || []).map((r: any) => ({
            id: r.id,
            name: r.full_name || 'Unnamed',
            phone: r.phone,
            date: r.created_at,
          })),
          total: count ?? data?.length ?? 0,
          truncated: (count ?? 0) > PAGE_SIZE,
        };
      }

      if (metric === 'tenants') {
        let q = supabase
          .from('rent_requests')
          .select('tenant_id, amount, status, created_at', { count: 'exact' })
          .in('status', ['disbursed', 'repaying', 'completed', 'funded'])
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso) q = q.lte('created_at', toIso);
        const { data, count, error } = await q;
        if (error) throw error;
        const rows = data || [];
        const tenantIds = [...new Set(rows.map((r: any) => r.tenant_id).filter(Boolean))] as string[];
        const { data: profiles } = tenantIds.length
          ? await supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds)
          : { data: [] as any[] };
        const map = new Map((profiles || []).map((p: any) => [p.id, p]));
        // Dedupe per tenant — keep most recent
        const seen = new Set<string>();
        const records: DrilldownRecord[] = [];
        for (const r of rows as any[]) {
          if (seen.has(r.tenant_id)) continue;
          seen.add(r.tenant_id);
          const p = map.get(r.tenant_id);
          records.push({
            id: r.tenant_id,
            name: p?.full_name || 'Unnamed',
            phone: p?.phone || null,
            amount: Number(r.amount || 0),
            date: r.created_at,
            meta: r.status,
          });
        }
        return { records, total: records.length, truncated: (count ?? 0) > PAGE_SIZE };
      }

      if (metric === 'agents') {
        let q = supabase
          .from('agent_earnings')
          .select('agent_id, amount, created_at', { count: 'exact' })
          .gt('amount', 0)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso) q = q.lte('created_at', toIso);
        const { data, count, error } = await q;
        if (error) throw error;
        const rows = data || [];
        // Aggregate per agent
        const agg = new Map<string, { total: number; last: string }>();
        for (const r of rows as any[]) {
          const cur = agg.get(r.agent_id) || { total: 0, last: r.created_at };
          cur.total += Number(r.amount || 0);
          if (r.created_at > cur.last) cur.last = r.created_at;
          agg.set(r.agent_id, cur);
        }
        const agentIds = [...agg.keys()];
        const { data: profiles } = agentIds.length
          ? await supabase.from('profiles').select('id, full_name, phone').in('id', agentIds)
          : { data: [] as any[] };
        const map = new Map((profiles || []).map((p: any) => [p.id, p]));
        const records: DrilldownRecord[] = agentIds
          .map((id) => {
            const p = map.get(id);
            const a = agg.get(id)!;
            return {
              id,
              name: p?.full_name || 'Unnamed',
              phone: p?.phone || null,
              amount: a.total,
              date: a.last,
              meta: 'earned',
            };
          })
          .sort((a, b) => (b.amount || 0) - (a.amount || 0));
        return { records, total: records.length, truncated: (count ?? 0) > PAGE_SIZE };
      }

      // partners
      if (metric === 'partners') {
        let q = supabase
        .from('investor_portfolios')
        .select('investor_id, investment_amount, status, created_at, portfolio_code', { count: 'exact' })
        .eq('status', 'active')
        .gt('investment_amount', 0)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso) q = q.lte('created_at', toIso);
        const { data, count, error } = await q;
        if (error) throw error;
        const rows = data || [];
      // Aggregate per investor
      const agg = new Map<string, { total: number; last: string; codes: number }>();
      for (const r of rows as any[]) {
        const cur = agg.get(r.investor_id) || { total: 0, last: r.created_at, codes: 0 };
        cur.total += Number(r.investment_amount || 0);
        cur.codes += 1;
        if (r.created_at > cur.last) cur.last = r.created_at;
        agg.set(r.investor_id, cur);
      }
      const ids = [...agg.keys()];
      const { data: profiles } = ids.length
        ? await supabase.from('profiles').select('id, full_name, phone').in('id', ids)
        : { data: [] as any[] };
      const map = new Map((profiles || []).map((p: any) => [p.id, p]));
      const records: DrilldownRecord[] = ids
        .map((id) => {
          const p = map.get(id);
          const a = agg.get(id)!;
          return {
            id,
            name: p?.full_name || 'Unnamed',
            phone: p?.phone || null,
            amount: a.total,
            date: a.last,
            meta: `${a.codes} portfolio${a.codes > 1 ? 's' : ''}`,
          };
        })
        .sort((a, b) => (b.amount || 0) - (a.amount || 0));
        return { records, total: records.length, truncated: (count ?? 0) > PAGE_SIZE };
      }

      // landlords_active / landlords_dormant
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      let lq = supabase
        .from('landlords')
        .select('id, name, phone, monthly_rent, rent_last_paid_at, rent_last_paid_amount, rent_balance_due, created_at, property_address, region, district, house_number, verified, ready_to_receive', { count: 'exact' })
        .limit(PAGE_SIZE);

      if (metric === 'landlords_active') {
        lq = lq.gte('rent_last_paid_at', ninetyDaysAgo).order('rent_last_paid_at', { ascending: false });
      } else {
        // dormant: never paid OR last paid before 90d ago
        lq = lq.or(`rent_last_paid_at.is.null,rent_last_paid_at.lt.${ninetyDaysAgo}`).order('created_at', { ascending: false });
      }

      // Date range applies to landlord registration (created_at)
      if (fromIso) lq = lq.gte('created_at', fromIso);
      if (toIso) lq = lq.lte('created_at', toIso);

      // Region filter (exact match)
      if (landlordFilters?.region && landlordFilters.region !== 'all') {
        lq = lq.eq('region', landlordFilters.region);
      }

      // Property text filter — match address, house number, or district
      const propQ = landlordFilters?.property?.trim();
      if (propQ) {
        const safe = propQ.replace(/[%,()]/g, ' ');
        lq = lq.or(
          `property_address.ilike.%${safe}%,house_number.ilike.%${safe}%,district.ilike.%${safe}%`,
        );
      }

      // Account status filter
      switch (landlordFilters?.accountStatus) {
        case 'verified':
          lq = lq.eq('verified', true);
          break;
        case 'unverified':
          lq = lq.or('verified.is.null,verified.eq.false');
          break;
        case 'ready':
          lq = lq.eq('ready_to_receive', true);
          break;
        case 'not_ready':
          lq = lq.or('ready_to_receive.is.null,ready_to_receive.eq.false');
          break;
      }

      const { data: lData, count: lCount, error: lErr } = await lq;
      if (lErr) throw lErr;
      const lRecords: DrilldownRecord[] = (lData || []).map((r: any) => {
        const locBits = [r.region, r.district].filter(Boolean).join(' · ');
        const statusBits: string[] = [];
        if (r.verified) statusBits.push('✓ verified');
        if (r.ready_to_receive) statusBits.push('💸 ready');
        const propertyBit = r.property_address
          ? `📍 ${r.property_address.slice(0, 40)}`
          : r.house_number
            ? `🏠 ${r.house_number}`
            : null;
        const metaParts =
          metric === 'landlords_active'
            ? [propertyBit, locBits, statusBits.join(' ')].filter(Boolean)
            : [
                r.rent_last_paid_at
                  ? `last paid ${new Date(r.rent_last_paid_at).toLocaleDateString()}`
                  : 'never paid',
                locBits,
                statusBits.join(' '),
              ].filter(Boolean);
        return {
          id: r.id,
          name: r.name || 'Unnamed',
          phone: r.phone || null,
          amount:
            metric === 'landlords_active'
              ? Number(r.rent_last_paid_amount || 0)
              : Number(r.rent_balance_due || 0),
          date: metric === 'landlords_active' ? r.rent_last_paid_at || r.created_at : r.created_at,
          meta: metaParts.join(' · '),
        };
      });

      // Pull distinct regions for filter chips (unfiltered, capped at 50)
      const { data: regionRows } = await supabase
        .from('landlords')
        .select('region')
        .not('region', 'is', null)
        .limit(2000);
      const regions = [...new Set((regionRows || []).map((r: any) => r.region).filter(Boolean))]
        .sort()
        .slice(0, 50);

      return {
        records: lRecords,
        total: lCount ?? lRecords.length,
        truncated: (lCount ?? 0) > PAGE_SIZE,
        regions,
      };
    },
  });
}