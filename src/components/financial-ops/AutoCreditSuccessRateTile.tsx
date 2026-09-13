import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { CheckCircle2, Zap, ChevronDown, ChevronUp, ArrowRightLeft } from 'lucide-react';
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

  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem('finops_autocredit_tile_open_v1') === 'true';
    } catch {
      return false;
    }
  });

  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('finops_autocredit_tile_open_v1', String(next));
      } catch { /* noop */ }
      return next;
    });
  };

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

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-2xs">
      <button
        type="button"
        onClick={toggleOpen}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold tracking-tight text-foreground">Auto-Credit Success Rate</h2>
              {hasActivity && (
                <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 border border-primary/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">
                  <Zap className="h-3 w-3" /> 24h
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              Parsed MTN/Airtel deposits auto-credited to a wallet.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <span className={`font-mono text-sm font-bold tabular-nums ${isLoading ? 'animate-pulse text-muted-foreground' : 'text-foreground'}`}>
            {isLoading ? '——' : displayPct === null ? '—' : `${displayPct}%`}
          </span>
          {open ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
        </div>
      </button>

      {open && (
        <div className="p-5 border-t border-border space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className={`font-mono text-2xl sm:text-3xl font-black tabular-nums ${isLoading ? 'animate-pulse text-muted-foreground' : 'text-foreground'}`}>
                {isLoading ? '——' : displayPct === null ? '—' : `${displayPct}%`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isLoading
                  ? 'Loading…'
                  : isError
                    ? "Couldn't load — try again shortly"
                    : hasActivity
                      ? `${data?.successful} of ${data?.attempted} deposits auto-credited successfully in the last 24h`
                      : 'No deposit SMS parsed in the last 24h'}
              </p>
            </div>
            {onClick && (
              <button
                type="button"
                onClick={onClick}
                className="inline-flex items-center gap-1.5 rounded-xl border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" /> Review Auto-Credits
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
