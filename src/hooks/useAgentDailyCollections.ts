import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, addDays, subDays, startOfMonth, startOfYear } from 'date-fns';

/**
 * Daily Rent Collections — one server-side request per period.
 *
 * Everything on the view (headline figures, per-agent bars, the collection
 * lines, and the top-12 ranking) comes from a single call to
 * `agent_daily_collections_overview`, so there is no N+1 enrichment and no
 * second round trip. Only money from active repaying plans is counted.
 */
export type CollectionsPeriod = 'today' | 'tomorrow' | '5d' | '7d' | 'month' | 'year';

export const PERIOD_LABELS: Record<CollectionsPeriod, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow (forecast)',
  '5d': 'Last 5 days',
  '7d': 'Last 7 days',
  month: 'This month',
  year: 'This year',
};

export interface CollectionsAgent {
  agent_id: string;
  agent_name: string;
  collected: number;
  expected: number;
  tenants: number;
  payments: number;
  success_rate: number;
}

export interface CollectionsLine {
  key: string;
  agent_id: string;
  agent_name: string;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  address: string;
  area: string;
  landlord_name: string;
  collected: number;
  expected: number;
  remaining: number;
  balance: number;
  payments: number;
  last_collected_at: string | null;
}

export interface CollectionsOverview {
  mode: 'actual' | 'forecast';
  from: string;
  to: string;
  days: number;
  kpis: {
    total_collected: number;
    total_expected: number;
    tenants_count: number;
    agents_count: number;
    areas_count: number;
  };
  agents: CollectionsAgent[];
  rows: CollectionsLine[];
  top_agents: CollectionsAgent[];
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/** Resolve a period to the date window + whether it is a forward forecast. */
export function resolvePeriod(period: CollectionsPeriod) {
  const today = new Date();
  switch (period) {
    case 'tomorrow': {
      const d = iso(addDays(today, 1));
      return { from: d, to: d, forecast: true };
    }
    case '5d':
      return { from: iso(subDays(today, 4)), to: iso(today), forecast: false };
    case '7d':
      return { from: iso(subDays(today, 6)), to: iso(today), forecast: false };
    case 'month':
      return { from: iso(startOfMonth(today)), to: iso(today), forecast: false };
    case 'year':
      return { from: iso(startOfYear(today)), to: iso(today), forecast: false };
    case 'today':
    default:
      return { from: iso(today), to: iso(today), forecast: false };
  }
}

const EMPTY: CollectionsOverview = {
  mode: 'actual',
  from: '',
  to: '',
  days: 1,
  kpis: { total_collected: 0, total_expected: 0, tenants_count: 0, agents_count: 0, areas_count: 0 },
  agents: [],
  rows: [],
  top_agents: [],
};

export function useAgentDailyCollections(period: CollectionsPeriod) {
  const qc = useQueryClient();
  const window = useMemo(() => resolvePeriod(period), [period]);
  const queryKey = ['agent-daily-collections', window.from, window.to, window.forecast] as const;

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<CollectionsOverview> => {
      const { data, error } = await supabase.rpc('agent_daily_collections_overview' as any, {
        p_from: window.from,
        p_to: window.to,
        p_forecast: window.forecast,
      });
      if (error) throw error;
      const d = (data as any) ?? {};
      return {
        ...EMPTY,
        ...d,
        kpis: { ...EMPTY.kpis, ...(d.kpis ?? {}) },
        agents: (d.agents ?? []) as CollectionsAgent[],
        rows: (d.rows ?? []) as CollectionsLine[],
        top_agents: (d.top_agents ?? []) as CollectionsAgent[],
      };
    },
    // Ops floor view: refreshed on a 60s cadence, and immediately whenever a new
    // collection lands (realtime below).
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const ch = supabase
      .channel(`agent-daily-collections-${window.from}-${window.to}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agent_collections' },
        () => {
          qc.invalidateQueries({ queryKey: ['agent-daily-collections'] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [window.from, window.to, qc]);

  return query;
}
