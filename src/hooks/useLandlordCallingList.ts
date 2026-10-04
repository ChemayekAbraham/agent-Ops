import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLandlordCallSummaries, type LandlordCallSummary } from './useLandlordCallReports';

/**
 * Read-only landlord population for the Landlord Calling Hub.
 *
 * Everything comes from `v_landlord_calling_base`, a summary view over the
 * existing `landlords`, `house_listings`, `rent_requests` and
 * `agent_landlord_payouts` records — no landlord, house or payout logic is
 * duplicated or changed here. Registering agent names are joined in from
 * `profiles`; call state comes from `v_landlord_call_summary`.
 */

export type LandlordCallScope = 'plans' | 'houses' | 'all';

const chunk = <T,>(list: T[], size = 300): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export interface LandlordCallingRow {
  landlord_id: string;
  landlord_name: string;
  phone: string;
  verified: boolean;
  has_smartphone: boolean | null;
  mobile_money_name: string | null;
  mobile_money_number: string | null;
  bank_name: string | null;
  account_number: string | null;
  caretaker_name: string | null;
  caretaker_phone: string | null;
  village: string | null;
  district: string | null;
  region: string | null;
  property_address: string | null;
  house_category: string | null;
  declared_houses: number;
  declared_monthly_rent: number;
  houses: number;
  occupied_houses: number;
  empty_houses: number;
  verified_houses: number;
  houses_monthly_rent: number;
  plans: number;
  funded_plans: number;
  plan_rent_total: number;
  last_plan_at: string | null;
  payout_count: number;
  paid_total: number;
  last_paid_at: string | null;
  registered_by: string | null;
  agent_name: string;
  agent_phone: string;
  created_at: string | null;
  call: LandlordCallSummary | null;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
}

const SELECT_COLS =
  'landlord_id, name, phone, verified, has_smartphone, mobile_money_name, mobile_money_number, bank_name, account_number, caretaker_name, caretaker_phone, number_of_houses, monthly_rent, village, district, region, property_address, house_category, registered_by, managed_by_agent_id, created_at, houses, occupied_houses, empty_houses, verified_houses, houses_monthly_rent, plans, funded_plans, plan_rent_total, last_plan_at, payout_count, paid_total, last_paid_at';

export function useLandlordCallingList(scope: LandlordCallScope = 'plans') {
  const { data: summaries, isLoading: callsLoading } = useLandlordCallSummaries();

  const { data: base, isLoading: baseLoading, refetch } = useQuery({
    queryKey: ['landlord-calling-base', scope],
    queryFn: async () => {
      const all: any[] = [];
      const page = 1000;
      const maxRows = scope === 'all' ? 20000 : 20000;
      for (let from = 0; from < maxRows; from += page) {
        let q = (supabase as any)
          .from('v_landlord_calling_base')
          .select(SELECT_COLS)
          .order('plan_rent_total', { ascending: false })
          .range(from, from + page - 1);
        if (scope === 'plans') q = q.gt('plans', 0);
        else if (scope === 'houses') q = q.gt('houses', 0);
        const { data, error } = await q;
        if (error) throw error;
        all.push(...(data || []));
        if (!data || data.length < page) break;
      }
      return all;
    },
    staleTime: 120000,
  });

  const agentIds = useMemo(() => {
    const ids = new Set<string>();
    (base || []).forEach((l: any) => {
      if (l.registered_by) ids.add(l.registered_by);
      if (l.managed_by_agent_id) ids.add(l.managed_by_agent_id);
    });
    return [...ids];
  }, [base]);

  const { data: profiles, isLoading: profLoading } = useQuery({
    queryKey: ['landlord-calling-agents', agentIds.length],
    queryFn: async () => {
      if (!agentIds.length) return [] as ProfileRow[];
      const batches = await Promise.all(
        chunk(agentIds).map(ids =>
          supabase.from('profiles').select('id, full_name, phone').in('id', ids),
        ),
      );
      return batches.flatMap(b => (b.data || [])) as ProfileRow[];
    },
    enabled: agentIds.length > 0,
    staleTime: 300000,
  });

  const rows = useMemo<LandlordCallingRow[]>(() => {
    if (!base?.length) return [];
    const pmap = new Map<string, ProfileRow>();
    (profiles || []).forEach(p => pmap.set(p.id, p));

    return (base as any[]).map(l => {
      const agent = pmap.get(l.managed_by_agent_id || l.registered_by || '');
      return {
        landlord_id: l.landlord_id,
        landlord_name: l.name || 'Unnamed landlord',
        phone: l.phone || '',
        verified: !!l.verified,
        has_smartphone: l.has_smartphone ?? null,
        mobile_money_name: l.mobile_money_name || null,
        mobile_money_number: l.mobile_money_number || null,
        bank_name: l.bank_name || null,
        account_number: l.account_number || null,
        caretaker_name: l.caretaker_name || null,
        caretaker_phone: l.caretaker_phone || null,
        village: l.village || null,
        district: l.district || null,
        region: l.region || null,
        property_address: l.property_address || null,
        house_category: l.house_category || null,
        declared_houses: Number(l.number_of_houses) || 0,
        declared_monthly_rent: Number(l.monthly_rent) || 0,
        houses: Number(l.houses) || 0,
        occupied_houses: Number(l.occupied_houses) || 0,
        empty_houses: Number(l.empty_houses) || 0,
        verified_houses: Number(l.verified_houses) || 0,
        houses_monthly_rent: Number(l.houses_monthly_rent) || 0,
        plans: Number(l.plans) || 0,
        funded_plans: Number(l.funded_plans) || 0,
        plan_rent_total: Number(l.plan_rent_total) || 0,
        last_plan_at: l.last_plan_at || null,
        payout_count: Number(l.payout_count) || 0,
        paid_total: Number(l.paid_total) || 0,
        last_paid_at: l.last_paid_at || null,
        registered_by: l.registered_by || null,
        agent_name: agent?.full_name || '—',
        agent_phone: agent?.phone || '',
        created_at: l.created_at || null,
        call: summaries?.get(l.landlord_id) || null,
      };
    });
  }, [base, profiles, summaries]);

  return {
    rows,
    isLoading: baseLoading || profLoading || callsLoading,
    refetch,
  };
}
