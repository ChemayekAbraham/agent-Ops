import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Clock } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

export interface PendingPortfolioSummary {
  pending_count: number;
  pending_value: number;
  oldest_wait_days: number;
}

export function usePendingPortfolioSummary() {
  return useQuery({
    queryKey: ['partner-ops-pending-portfolio-summary'],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_pending_portfolio_summary' as any);
      if (error) throw error;
      const row = ((data as any[]) || [])[0];
      return {
        pending_count: Number(row?.pending_count || 0),
        pending_value: Number(row?.pending_value || 0),
        oldest_wait_days: Number(row?.oldest_wait_days || 0),
      } as PendingPortfolioSummary;
    },
  });
}

export function PendingPortfoliosCard({ onClick }: { onClick?: () => void }) {
  const { data, isLoading } = usePendingPortfolioSummary();

  const count = data?.pending_count ?? 0;
  const oldest = data?.oldest_wait_days ?? 0;
  const tone = oldest > 2
    ? 'border-destructive/50 bg-destructive/5 text-destructive'
    : count > 0
      ? 'border-amber-500/50 bg-amber-500/5 text-amber-600'
      : 'border-border/60 bg-card text-muted-foreground';

  return (
    <button
      onClick={onClick}
      className={`rounded-2xl border p-4 text-left transition-colors ${tone}`}
    >
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4" />
        <span className="text-[11px] uppercase tracking-wider font-bold">Pending Portfolios</span>
      </div>
      <p className="mt-2 text-2xl font-black text-foreground tabular-nums">
        {isLoading ? '—' : count}
      </p>
      <p className="text-[11px] font-medium mt-1">
        {isLoading
          ? 'Loading…'
          : count === 0
            ? 'Nothing awaiting approval'
            : `${formatUGX(data?.pending_value || 0)} awaiting · oldest ${oldest}d`}
      </p>
    </button>
  );
}
