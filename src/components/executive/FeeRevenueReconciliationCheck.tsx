import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, ShieldAlert, RefreshCw } from 'lucide-react';

/** One reconciled line: authoritative RPC total vs the row-capped client sum. */
type Line = {
  key: string;
  label: string;
  authoritative: number;
  clientSum: number;
};

const num = (n: number) => Number(n || 0).toLocaleString();

/**
 * Fee Revenue Reconciliation Check
 *
 * Compares the exact server-aggregated totals from `get_fee_revenue_summary`
 * against the legacy client-side row sums (which the Data API caps at 1,000
 * rows). Any drift proves the fallback path is under-counting and is flagged
 * so no dashboard ever quietly ships a truncated financial figure.
 */
export function FeeRevenueReconciliationCheck() {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['fee-revenue-reconciliation'],
    staleTime: 60000,
    queryFn: async () => {
      // 1. Authoritative — exact server-side SUM (no row cap).
      const { data: summary, error } = await supabase.rpc('get_fee_revenue_summary', { p_months: 6 });
      if (error) throw error;
      const s = (summary || {}) as any;

      // 2. Fallback — client-side row sum, subject to the 1,000-row Data API cap.
      const { data: rows } = await supabase
        .from('fee_revenue_ledger')
        .select('total_amount, recognized_amount, deferred_amount')
        .limit(20000);
      const client = (rows || []).reduce(
        (acc, r) => {
          acc.billed += Number(r.total_amount || 0);
          acc.recognized += Number(r.recognized_amount || 0);
          acc.deferred += Number(r.deferred_amount || 0);
          return acc;
        },
        { billed: 0, recognized: 0, deferred: 0 },
      );

      const lines: Line[] = [
        { key: 'billed', label: 'Billed', authoritative: Number(s.billed || 0), clientSum: client.billed },
        { key: 'recognized', label: 'Recognized', authoritative: Number(s.recognized || 0), clientSum: client.recognized },
        { key: 'deferred', label: 'Deferred', authoritative: Number(s.deferred || 0), clientSum: client.deferred },
      ];

      return {
        lines,
        serverRows: Number(s.row_count || 0),
        clientRows: (rows || []).length,
      };
    },
  });

  const lines = data?.lines || [];
  const rowsCapped = !!data && data.clientRows < data.serverRows;
  const anyMismatch = lines.some((l) => Math.round(l.authoritative) !== Math.round(l.clientSum));

  const status = isLoading
    ? 'loading'
    : anyMismatch
      ? 'mismatch'
      : 'ok';

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2.5 p-3 sm:p-4 border-b border-border">
        <div
          className={cn(
            'p-2 rounded-lg shrink-0',
            status === 'mismatch' ? 'bg-rose-500/10 text-rose-600'
              : status === 'ok' ? 'bg-emerald-500/10 text-emerald-600'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {status === 'mismatch' ? <ShieldAlert className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-tight">Fee Revenue Reconciliation</h3>
          <p className="text-xs text-muted-foreground">
            Exact server totals vs the row-capped client fallback
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="p-2 rounded-lg hover:bg-muted transition-colors shrink-0"
          aria-label="Re-run reconciliation"
        >
          <RefreshCw className={cn('h-4 w-4 text-muted-foreground', isFetching && 'animate-spin')} />
        </button>
      </div>

      {/* Verdict banner */}
      {!isLoading && (
        <div
          className={cn(
            'flex items-start gap-2 px-4 py-2.5 text-xs',
            anyMismatch ? 'bg-rose-500/5 text-rose-600' : 'bg-emerald-500/5 text-emerald-600',
          )}
        >
          {anyMismatch ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> : <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />}
          <span className="font-medium">
            {anyMismatch
              ? `Mismatch detected — the client fallback is under-counting because it only reads ${num(data?.clientRows || 0)} of ${num(data?.serverRows || 0)} rows. Always use the server total.`
              : `All totals reconcile exactly across ${num(data?.serverRows || 0)} fee records.`}
          </span>
        </div>
      )}

      {/* Comparison table */}
      <div className="hidden sm:grid grid-cols-[1fr_repeat(3,1.2fr)] gap-2 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted/30">
        <span>Metric</span>
        <span className="text-right">Server (exact)</span>
        <span className="text-right">Client (capped)</span>
        <span className="text-right">Drift</span>
      </div>

      <div className="divide-y divide-border">
        {isLoading &&
          [0, 1, 2].map((i) => (
            <div key={i} className="px-4 py-3">
              <div className="h-6 w-full bg-muted animate-pulse rounded" />
            </div>
          ))}

        {!isLoading &&
          lines.map((l) => {
            const drift = Math.round(l.clientSum) - Math.round(l.authoritative);
            const mismatch = drift !== 0;
            return (
              <div
                key={l.key}
                className="grid grid-cols-2 sm:grid-cols-[1fr_repeat(3,1.2fr)] gap-2 px-4 py-3 items-center"
              >
                <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
                  {mismatch ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                  )}
                  <span className="text-sm font-semibold">{l.label}</span>
                </div>
                <Cell mLabel="Server (exact)" value={formatUGX(l.authoritative)} strong />
                <Cell mLabel="Client (capped)" value={formatUGX(l.clientSum)} muted={mismatch} />
                <div className="text-right">
                  <span className="sm:hidden text-[10px] text-muted-foreground block">Drift</span>
                  <span
                    className={cn(
                      'text-sm font-bold tabular-nums',
                      mismatch ? 'text-rose-600' : 'text-muted-foreground',
                    )}
                  >
                    {drift === 0 ? '—' : `${drift > 0 ? '+' : ''}${formatUGX(drift)}`}
                  </span>
                </div>
              </div>
            );
          })}
      </div>

      {!isLoading && (
        <div className="px-4 py-2.5 text-[10px] text-muted-foreground border-t border-border">
          Server rows aggregated: <span className="font-semibold text-foreground">{num(data?.serverRows || 0)}</span>
          {' · '}Client rows read: <span className="font-semibold text-foreground">{num(data?.clientRows || 0)}</span>
          {rowsCapped && <span className="text-rose-600 font-medium"> (fallback truncated by the 1,000-row Data API cap)</span>}
        </div>
      )}
    </div>
  );
}

function Cell({ mLabel, value, strong, muted }: { mLabel: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="text-right">
      <span className="sm:hidden text-[10px] text-muted-foreground block">{mLabel}</span>
      <span className={cn('text-sm tabular-nums', strong ? 'font-bold' : 'font-medium', muted && 'text-rose-600')}>
        {value}
      </span>
    </div>
  );
}