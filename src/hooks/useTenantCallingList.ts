import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useTenantCallSummaries, type TenantCallSummary } from './useTenantCallReports';

/**
 * Read-only tenant population for the Tenant Calling Hub.
 *
 * Population and money figures come from `v_tenant_daily_eligibility` — the
 * same authoritative view the Daily Payments and Missed Days tools use — so no
 * tenant/rent logic is duplicated or changed here. Names, phones and locations
 * are joined in from `profiles`; call state comes from `v_tenant_call_summary`.
 */

const chunk = <T,>(list: T[], size = 300): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export interface CallingListRow {
  tenant_id: string;
  rent_request_id: string;
  tenant_name: string;
  phone: string;
  email: string | null;
  national_id: string | null;
  occupation: string | null;
  preferred_language: string | null;
  has_smartphone: boolean | null;
  tenant_status: string | null;
  tenant_house_category: string | null;
  mobile_money_number: string | null;
  mobile_money_name: string | null;
  last_active_at: string | null;
  ops_note: string | null;
  district: string | null;
  village: string | null;
  sub_county: string | null;
  parish: string | null;
  landmark: string | null;
  city: string | null;
  region: string | null;
  status: string | null;
  agent_id: string | null;
  agent_name: string;
  agent_phone: string;
  landlord_id: string | null;
  landlord_name: string;
  landlord_phone: string;
  rent_amount: number;
  daily_repayment: number;
  amount_repaid: number;
  total_repayment: number;
  outstanding_balance: number;
  start_at: string | null;
  days_since_start: number;
  expected_repaid: number;
  missed_days: number;
  repayment_pct: number;
  call: TenantCallSummary | null;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  national_id: string | null;
  occupation: string | null;
  preferred_language: string | null;
  has_smartphone: boolean | null;
  tenant_status: string | null;
  tenant_house_category: string | null;
  mobile_money_number: string | null;
  mobile_money_name: string | null;
  last_active_at: string | null;
  ops_note: string | null;
  district: string | null;
  village: string | null;
  sub_county: string | null;
  parish: string | null;
  landmark: string | null;
  city: string | null;
  region: string | null;
}

const PROFILE_COLS =
  'id, full_name, phone, email, national_id, occupation, preferred_language, has_smartphone, tenant_status, tenant_house_category, mobile_money_number, mobile_money_name, last_active_at, ops_note, district, village, sub_county, parish, landmark, city, region';

export function useTenantCallingList() {
  const { data: summaries, isLoading: callsLoading } = useTenantCallSummaries();

  const { data: plans, isLoading: plansLoading, refetch } = useQuery({
    queryKey: ['calling-hub-plans'],
    queryFn: async () => {
      const all: any[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        // Full callable population: every tenant on an active rent plan.
        // (The eligibility view narrows to money-due/defaulting rows, which is
        // not the right population for a calling list.)
        const { data, error } = await supabase
          .from('rent_requests')
          .select('id, tenant_id, agent_id, landlord_id, daily_repayment, rent_amount, amount_repaid, total_repayment, disbursed_at, funded_at, created_at, status')
          .in('status', ['funded', 'repaying'])
          .not('tenant_id', 'is', null)
          .order('created_at', { ascending: false })
          .range(from, from + page - 1);
        if (error) throw error;
        all.push(
          ...(data || []).map((r: any) => ({
            ...r,
            rent_request_id: r.id,
            start_at: r.disbursed_at || r.funded_at || r.created_at,
          })),
        );
        if (!data || data.length < page) break;
      }
      return all;
    },

    staleTime: 120000,
  });

  const userIds = useMemo(() => {
    const ids = new Set<string>();
    (plans || []).forEach((p: any) => {
      if (p.tenant_id) ids.add(p.tenant_id);
      if (p.agent_id) ids.add(p.agent_id);
      if (p.landlord_id) ids.add(p.landlord_id);
    });
    return [...ids];
  }, [plans]);

  const { data: profiles, isLoading: profLoading } = useQuery({
    queryKey: ['calling-hub-profiles', userIds.length],
    queryFn: async () => {
      if (!userIds.length) return [] as ProfileRow[];
      const batches = await Promise.all(
        chunk(userIds).map(ids =>
          supabase
            .from('profiles')
            .select(PROFILE_COLS)
            .in('id', ids),
        ),
      );
      return batches.flatMap(b => (b.data || [])) as ProfileRow[];
    },
    enabled: userIds.length > 0,
    staleTime: 300000,
  });

  const rows = useMemo<CallingListRow[]>(() => {
    if (!plans?.length) return [];
    const pmap = new Map<string, ProfileRow>();
    (profiles || []).forEach(p => pmap.set(p.id, p));

    // One row per tenant — newest plan wins (the view is ordered by start_at desc).
    const seen = new Set<string>();
    const out: CallingListRow[] = [];

    for (const p of plans as any[]) {
      if (!p.tenant_id || seen.has(p.tenant_id)) continue;
      seen.add(p.tenant_id);

      const t = pmap.get(p.tenant_id);
      const a = p.agent_id ? pmap.get(p.agent_id) : undefined;
      const l = p.landlord_id ? pmap.get(p.landlord_id) : undefined;

      const daily = Number(p.daily_repayment) || 0;
      const repaid = Number(p.amount_repaid) || 0;
      const total = Number(p.total_repayment) || 0;
      const start = p.start_at ? new Date(p.start_at) : null;
      const days = start ? Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000)) : 0;
      const expected = daily * days;
      const missed = daily > 0 ? Math.max(0, Math.floor((expected - repaid) / daily)) : 0;

      out.push({
        tenant_id: p.tenant_id,
        rent_request_id: p.rent_request_id,
        tenant_name: t?.full_name || 'Unknown tenant',
        phone: t?.phone || '',
        email: t?.email || null,
        national_id: t?.national_id || null,
        occupation: t?.occupation || null,
        preferred_language: t?.preferred_language || null,
        has_smartphone: t?.has_smartphone ?? null,
        tenant_status: t?.tenant_status || null,
        tenant_house_category: t?.tenant_house_category || null,
        mobile_money_number: t?.mobile_money_number || null,
        mobile_money_name: t?.mobile_money_name || null,
        last_active_at: t?.last_active_at || null,
        ops_note: t?.ops_note || null,
        district: t?.district || null,
        village: t?.village || null,
        sub_county: t?.sub_county || null,
        parish: t?.parish || null,
        landmark: t?.landmark || null,
        city: t?.city || null,
        region: t?.region || null,
        status: p.status || null,
        agent_id: p.agent_id || null,
        agent_name: a?.full_name || '—',
        agent_phone: a?.phone || '',
        landlord_id: p.landlord_id || null,
        landlord_name: l?.full_name || '—',
        landlord_phone: l?.phone || '',
        rent_amount: Number(p.rent_amount) || 0,
        daily_repayment: daily,
        amount_repaid: repaid,
        total_repayment: total,
        outstanding_balance: Math.max(0, total - repaid),
        start_at: p.start_at || null,
        days_since_start: days,
        expected_repaid: expected,
        missed_days: missed,
        repayment_pct: total > 0 ? Math.min(100, Math.round((repaid / total) * 100)) : 0,
        call: summaries?.get(p.tenant_id) || null,
      });
    }

    return out;
  }, [plans, profiles, summaries]);

  return {
    rows,
    isLoading: plansLoading || profLoading || callsLoading,
    refetch,
  };
}
