import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type DayTenant = { tenant_id: string; name: string; phone: string | null; expected: number; collected: number };
export type DayCell = { day: string; expected: number; collected: number; tenants: DayTenant[] };

/** Kampala (UTC+3) calendar day for a timestamp. */
export function kampalaDay(ts: string): string {
  return new Date(new Date(ts).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Read-only: the signed-in agent's pinned expected amounts per tenant per day
 * (agent_expected_day_plans) against non-reversed collections (agent_collections).
 */
export function useMyDailyCollections(from: string | null, to: string | null, names: Record<string, { name: string; phone: string | null }>) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-daily-collections', user?.id, from, to],
    enabled: !!user?.id && !!from && !!to,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, DayCell>> => {
      const [plans, cols] = await Promise.all([
        (supabase.from as any)('agent_expected_day_plans')
          .select('day, tenant_id, expected_ugx').eq('agent_id', user!.id)
          .gte('day', from).lte('day', to).limit(5000),
        (supabase.from as any)('agent_collections')
          .select('tenant_id, amount, created_at, reversed_at').eq('agent_id', user!.id)
          .is('reversed_at', null)
          .gte('created_at', `${from}T00:00:00+03:00`).lte('created_at', `${to}T23:59:59+03:00`).limit(5000),
      ]);
      if (plans.error) throw plans.error;
      if (cols.error) throw cols.error;
      const cells: Record<string, DayCell> = {};
      const get = (day: string, tid: string) => {
        const c = (cells[day] ??= { day, expected: 0, collected: 0, tenants: [] });
        let t = c.tenants.find((x) => x.tenant_id === tid);
        if (!t) {
          t = { tenant_id: tid, name: names[tid]?.name ?? 'Tenant', phone: names[tid]?.phone ?? null, expected: 0, collected: 0 };
          c.tenants.push(t);
        }
        return { c, t };
      };
      for (const r of plans.data ?? []) {
        const { c, t } = get(r.day, r.tenant_id ?? 'unknown');
        const v = Number(r.expected_ugx) || 0; c.expected += v; t.expected += v;
      }
      for (const r of cols.data ?? []) {
        const { c, t } = get(kampalaDay(r.created_at), r.tenant_id ?? 'unknown');
        const v = Number(r.amount) || 0; c.collected += v; t.collected += v;
      }
      Object.values(cells).forEach((c) => c.tenants.sort((a, b) => b.expected - a.expected));
      return cells;
    },
  });
}
