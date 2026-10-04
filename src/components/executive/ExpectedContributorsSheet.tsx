import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { ACTIVE_RENT_STATUSES } from '@/hooks/useAgentCapacityMap';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Loader2, Target } from 'lucide-react';

type RentRow = {
  id: string;
  tenant_id: string | null;
  agent_id: string | null;
  daily_repayment: number | null;
  rent_amount: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  status: string | null;
};

async function fetchActiveRents(agentId?: string | null): Promise<RentRow[]> {
  const all: RentRow[] = [];
  const PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase
      .from('rent_requests')
      .select('id, tenant_id, agent_id, daily_repayment, rent_amount, total_repayment, amount_repaid, status')
      .in('status', ACTIVE_RENT_STATUSES)
      .not('agent_id', 'is', null)
      .order('daily_repayment', { ascending: false })
      .range(from, from + PAGE - 1);
    if (agentId) q = q.eq('agent_id', agentId);
    const { data, error } = await q;
    if (error) { console.error('[ExpectedContributors] page failed', error); break; }
    const rows = (data || []) as RentRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const BATCH = 100;
  for (let i = 0; i < unique.length; i += BATCH) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', unique.slice(i, i + BATCH));
    (data || []).forEach((p: any) => {
      map.set(p.id, p.full_name || p.phone || p.id.slice(0, 8));
    });
  }
  return map;
}

export function ExpectedContributorsSheet({
  open,
  onOpenChange,
  days,
  agentId,
  agentName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  days: number;
  agentId?: string | null;
  agentName?: string | null;
}) {
  const { data: rents = [], isLoading } = useQuery({
    queryKey: ['expected-contributors', agentId || 'all'],
    queryFn: () => fetchActiveRents(agentId),
    enabled: open,
    staleTime: 30_000,
  });

  const nameIds = useMemo(() => {
    const s = new Set<string>();
    rents.forEach((r) => {
      if (r.tenant_id) s.add(r.tenant_id);
      if (!agentId && r.agent_id) s.add(r.agent_id);
    });
    return Array.from(s);
  }, [rents, agentId]);

  const { data: names } = useQuery({
    queryKey: ['expected-contributor-names', agentId || 'all', nameIds.length],
    queryFn: () => fetchNames(nameIds),
    enabled: open && nameIds.length > 0,
    staleTime: 5 * 60_000,
  });
  const nameById = names || new Map<string, string>();

  const rows = useMemo(() => {
    return rents.map((r) => {
      const daily = Number(r.daily_repayment) || 0;
      return {
        id: r.id,
        tenantId: r.tenant_id,
        agentId: r.agent_id,
        daily,
        contribution: daily * days,
        rent: Number(r.rent_amount) || 0,
        total: Number(r.total_repayment) || 0,
        repaid: Number(r.amount_repaid) || 0,
        status: r.status || '—',
      };
    }).sort((a, b) => b.contribution - a.contribution);
  }, [rents, days]);

  const totalDaily = rows.reduce((s, r) => s + r.daily, 0);
  const totalContribution = rows.reduce((s, r) => s + r.contribution, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base inline-flex items-center gap-2">
            <Target className="h-4 w-4 text-violet-600" />
            Expected · {days} day{days === 1 ? '' : 's'}
            {agentId ? ` · ${agentName || 'Agent'}` : ' · Fleet'}
          </SheetTitle>
          <SheetDescription className="text-[11px]">
            Active rent plans contributing to Expected. Expected = daily repayment × {days} day{days === 1 ? '' : 's'}.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-md border border-border bg-muted/30 p-2">
            <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Active plans</p>
            <p className="mt-0.5 tabular-nums font-bold">{rows.length.toLocaleString()}</p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-2">
            <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Daily total</p>
            <p className="mt-0.5 tabular-nums font-bold">{formatUGX(totalDaily)}</p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-2">
            <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Expected · {days}d</p>
            <p className="mt-0.5 tabular-nums font-bold text-violet-600">{formatUGX(totalContribution)}</p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="mt-6 text-center text-[11px] text-muted-foreground">No active rent plans contributing to Expected.</p>
        ) : (
          <div className="mt-3 rounded-md border border-border overflow-hidden">
            <div className="max-h-[65vh] overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-muted text-muted-foreground">
                  <tr>
                    <th className="text-left font-bold uppercase tracking-wide px-2 py-1.5 text-[9px]">Tenant</th>
                    {!agentId && <th className="text-left font-bold uppercase tracking-wide px-2 py-1.5 text-[9px] hidden sm:table-cell">Agent</th>}
                    <th className="text-left font-bold uppercase tracking-wide px-2 py-1.5 text-[9px] hidden sm:table-cell">Status</th>
                    <th className="text-right font-bold uppercase tracking-wide px-2 py-1.5 text-[9px]">Daily</th>
                    <th className="text-right font-bold uppercase tracking-wide px-2 py-1.5 text-[9px]">Expected · {days}d</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 py-1.5 truncate max-w-[10rem]">{(r.tenantId && nameById.get(r.tenantId)) || '—'}</td>
                      {!agentId && <td className="px-2 py-1.5 truncate max-w-[9rem] hidden sm:table-cell">{(r.agentId && nameById.get(r.agentId)) || '—'}</td>}
                      <td className="px-2 py-1.5 text-muted-foreground hidden sm:table-cell">{r.status}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(r.daily)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-violet-600">{formatUGX(r.contribution)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-muted/80 backdrop-blur border-t border-border">
                  <tr>
                    <td className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide" colSpan={agentId ? 3 : 4}>
                      Total · {rows.length} plan{rows.length === 1 ? '' : 's'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-bold text-violet-600">{formatUGX(totalContribution)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default ExpectedContributorsSheet;