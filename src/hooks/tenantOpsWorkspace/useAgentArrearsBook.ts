/** Reads tops_agent_arrears_book(p_as_at) — one row per (agent, bucket) on the same 1-7/8-14/15-30/30+ ladder tops_arrears_ageing uses. */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type ArrearsBucketKey = '1-7' | '8-14' | '15-30' | '30+';

export interface AgentArrearsBookRow {
  agent_id: string;
  agent_name: string | null;
  bucket: ArrearsBucketKey;
  plan_count: number;
  arrears_ugx: number;
}

export interface AgentArrearsBook {
  agentId: string;
  agentName: string | null;
  byBucket: Record<ArrearsBucketKey, { planCount: number; arrearsUgx: number }>;
  totalArrearsUgx: number;
}

async function fetchAgentArrearsBook(asAt: string | null): Promise<AgentArrearsBookRow[]> {
  const { data, error } = await anyDb.rpc('tops_agent_arrears_book', { p_as_at: asAt });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name ?? null,
    bucket: r.bucket as ArrearsBucketKey,
    plan_count: Number(r.plan_count),
    arrears_ugx: Number(r.arrears_ugx),
  }));
}

export function useAgentArrearsBook(asAt: string | null) {
  const query = useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentArrearsBook', asAt],
    queryFn: () => fetchAgentArrearsBook(asAt),
    staleTime: 30_000,
  });

  const byAgent = useMemo(() => {
    const map = new Map<string, AgentArrearsBook>();
    for (const row of query.data ?? []) {
      let entry = map.get(row.agent_id);
      if (!entry) {
        entry = {
          agentId: row.agent_id,
          agentName: row.agent_name,
          byBucket: {
            '1-7': { planCount: 0, arrearsUgx: 0 },
            '8-14': { planCount: 0, arrearsUgx: 0 },
            '15-30': { planCount: 0, arrearsUgx: 0 },
            '30+': { planCount: 0, arrearsUgx: 0 },
          },
          totalArrearsUgx: 0,
        };
        map.set(row.agent_id, entry);
      }
      entry.byBucket[row.bucket] = { planCount: row.plan_count, arrearsUgx: row.arrears_ugx };
      entry.totalArrearsUgx += row.arrears_ugx;
    }
    return Array.from(map.values()).sort((a, b) => b.totalArrearsUgx - a.totalArrearsUgx);
  }, [query.data]);

  return { ...query, byAgent };
}
