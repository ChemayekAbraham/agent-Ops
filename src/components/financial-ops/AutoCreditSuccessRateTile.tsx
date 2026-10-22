import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ArrowRight, LineChart } from 'lucide-react';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';

interface AutoCreditSuccessRateTileProps {
  /** Opens the Auto-Credit Review tool so a low rate is immediately actionable. */
  onClick?: () => void;
}

interface SuccessRateData {
  attempted: number;
  successful: number;
  successRatePct: number | null;
}

export function AutoCreditSuccessRateTile({ onClick }: AutoCreditSuccessRateTileProps) {
  const autoRefresh = useFinOpsAutoRefresh();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['finops-autocredit-success-rate', 24],
    queryFn: async (): Promise<SuccessRateData> => {
      const { data, error } = await supabase.rpc('get_deposit_autocredit_success_rate' as any, { p_window_hours: 24 });
      if (error) throw error;
      const raw = data as any;
      const d = (Array.isArray(raw) ? raw[0] : raw) ?? {};
      const pct = d.success_rate_pct ?? d.successRatePct;
      return {
        attempted: Number(d?.attempted ?? 0),
        successful: Number(d?.successful ?? 0),
        successRatePct: pct === null || pct === undefined || !Number.isFinite(Number(pct)) ? null : Number(pct),
      };
    },
    staleTime: 60_000,
    refetchInterval: autoRefresh ? 60_000 : false,
  });

  const hasActivity = !isLoading && !isError && (data?.attempted ?? 0) > 0;
  // `data` stays undefined (not null) when the RPC call itself fails, e.g. a
  // migration hasn't been applied yet — treat that the same as "no rate" so
  // the hero number never renders the literal string "undefined%".
  const displayPct = data?.successRatePct ?? null;

  const detail = isLoading
    ? 'Loading…'
    : isError
      ? "Couldn't load — try again shortly"
      : hasActivity
        ? `${data?.successful} of ${data?.attempted} deposits · Last 24h`
        : 'No deposit SMS parsed in the last 24h';

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-border bg-card px-4 py-3.5 sm:px-5 shadow-2xs">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <LineChart className="h-5 w-5 text-primary" aria-hidden="true" />
        </div>
        <h2 className="text-sm sm:text-base font-bold tracking-tight text-foreground">Auto-Credit Success Rate</h2>
      </div>
      <p className={`text-2xl sm:text-3xl font-black tabular-nums tracking-tight ${isLoading ? 'animate-pulse text-muted-foreground' : 'text-foreground'}`}>
        {isLoading ? '——' : displayPct === null ? '—' : `${displayPct.toFixed(1)}%`}
      </p>
      <p className="text-xs text-muted-foreground flex-1 min-w-[10rem]">{detail}</p>
      {onClick && (
        <button
          type="button"
          onClick={onClick}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Review Auto-Credits <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
