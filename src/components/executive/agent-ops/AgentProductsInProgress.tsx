import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/utils';

const STAGE: Record<string, { label: string; cls: string }> = {
  pending_approval: { label: 'Agent Ops', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  submitted: { label: 'Agent Ops', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  processing: { label: 'Agent Ops', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  ops_approved: { label: 'COO', cls: 'bg-sky-500/15 text-sky-700 border-sky-500/30' },
  coo_approved: { label: 'CFO', cls: 'bg-violet-500/15 text-violet-700 border-violet-500/30' },
};

export function useAgentProductsInProgress(category?: string) {
  return useQuery({
    queryKey: ['agent-products-in-progress', category],
    enabled: !!category,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('list_agent_products_in_progress', { p_category: category });
      if (error) throw error;
      return (data || []) as any[];
    },
    staleTime: 60_000,
  });
}

export function AgentProductsInProgress({ category }: { category?: string }) {
  const { data = [], isLoading, error } = useAgentProductsInProgress(category);
  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (error) return <p className="text-sm text-destructive">Could not load orders: {(error as Error).message}</p>;
  const counts = data.reduce((m: Record<string, number>, r) => { const l = STAGE[r.order_status]?.label ?? 'Other'; m[l] = (m[l] || 0) + 1; return m; }, {});
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {['Agent Ops', 'COO', 'CFO'].map((s) => (
          <div key={s} className="rounded-xl border bg-card p-3">
            <p className="text-xs text-muted-foreground">Waiting at {s}</p>
            <p className="text-xl font-bold">{counts[s] || 0}</p>
          </div>
        ))}
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No orders waiting for approval.</p>
      ) : (
        <div className="rounded-xl border bg-card divide-y">
          {data.map((r) => {
            const st = STAGE[r.order_status] ?? { label: r.order_status, cls: '' };
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm truncate">{r.client_name || 'Unknown agent'}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {r.item_name} × {r.quantity ?? 1} · {new Date(r.created_at).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala' })}
                  </p>
                </div>
                <span className="text-sm font-semibold">{formatUGX(Number(r.total_revenue || 0))}</span>
                <Badge variant="outline" className={st.cls}>Waiting at {st.label}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
