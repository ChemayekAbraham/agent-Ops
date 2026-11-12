import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';

/**
 * Nightly financial statements tie-out (fin_daily_tieout, written at 23:30 Kampala by fin_run_daily_tieout).
 * Shows the latest run: Balance Sheet and trial balance differences, the cash flow tie, every ledger-vs-operational
 * tie, and which ties moved since the previous night. Read-only.
 */
export interface DailyTieoutRow {
  run_date: string;
  as_at: string;
  status: 'ok' | 'attention' | 'failed';
  bs_difference: number | null;
  tb_difference: number | null;
  total_assets: number | null;
  ties: { key: string; label: string; ledger: number; operational: number; difference: number }[];
  cash_flow: { closing: number; balance_sheet_cash: number; ties: boolean; unexplained: number } | null;
  changes: { key: string; label: string; previous: number | null; current: number; moved_by: number }[];
  error: string | null;
}

export async function fetchLatestTieouts(): Promise<DailyTieoutRow[]> {
  // fin_daily_tieout is not in the generated types yet; RLS limits it to finance viewers.
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: unknown; error: { message: string } | null }> } } };
  }).from('fin_daily_tieout')
    .select('run_date, as_at, status, bs_difference, tb_difference, total_assets, ties, cash_flow, changes, error')
    .order('run_date', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data as DailyTieoutRow[] | null) ?? [];
}

const STATUS = {
  ok: { label: 'All checks tie', icon: CheckCircle2, cls: 'text-emerald-600 border-emerald-500/40 bg-emerald-500/5' },
  attention: { label: 'Needs attention', icon: AlertTriangle, cls: 'text-amber-700 dark:text-amber-400 border-amber-500/40 bg-amber-500/5' },
  failed: { label: 'Run failed', icon: XCircle, cls: 'text-destructive border-destructive/40 bg-destructive/5' },
} as const;

const tick = (ok: boolean) => (ok ? 'text-emerald-600' : 'text-destructive');

export default function DailyTieoutCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['fin-daily-tieout-latest'],
    queryFn: fetchLatestTieouts,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  const run = data?.[0];

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-widest text-primary">Nightly tie-out</p>
      {isLoading && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading the latest tie-out…
        </p>
      )}
      {error && <p className="text-xs text-destructive">Could not load the tie-out: {(error as Error).message}</p>}
      {!isLoading && !error && !run && (
        <p className="text-xs text-muted-foreground">No tie-out has run yet. It runs every night at 23:30.</p>
      )}
      {run && (() => {
        const s = STATUS[run.status];
        const Icon = s.icon;
        const bsOk = Math.abs(run.bs_difference ?? 0) < 1;
        const tbOk = Math.abs(run.tb_difference ?? 0) < 1;
        const cfOk = !!run.cash_flow?.ties;
        const moved = new Map(run.changes.map((c) => [c.key, c]));
        return (
          <div className="space-y-2">
            <div className={cn('flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5', s.cls)}>
              <span className="flex items-center gap-1.5 text-xs font-semibold"><Icon className="h-3.5 w-3.5" />{s.label}</span>
              <span className="text-[11px] text-muted-foreground">
                {format(new Date(run.as_at), 'dd MMM yyyy, HH:mm')}
              </span>
            </div>
            {run.error && <p className="text-[11px] text-destructive">{run.error}</p>}
            <ul className="space-y-0.5 text-xs">
              <li className={tick(bsOk)}>Balance Sheet: assets = liabilities + equity (difference {formatUGX(run.bs_difference ?? 0)})</li>
              <li className={tick(tbOk)}>Trial balance: debits = credits (difference {formatUGX(run.tb_difference ?? 0)})</li>
              <li className={tick(cfOk)}>
                Cash Flow: closing cash {run.cash_flow ? formatUGX(run.cash_flow.closing) : '—'} vs Balance Sheet cash{' '}
                {run.cash_flow ? formatUGX(run.cash_flow.balance_sheet_cash) : '—'}
              </li>
            </ul>
            {run.ties.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-1 font-medium">Ledger vs operational</th>
                      <th className="py-1 font-medium text-right">Difference</th>
                      <th className="py-1 font-medium text-right">Since previous night</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.ties.map((t) => {
                      const m = moved.get(t.key);
                      return (
                        <tr key={t.key} className="border-b border-border/50 last:border-0">
                          <td className="py-1 pr-2">{t.label}</td>
                          <td className={cn('py-1 text-right font-mono tabular-nums', tick(Math.abs(t.difference) < 1))}>{formatUGX(t.difference)}</td>
                          <td className={cn('py-1 text-right font-mono tabular-nums', m ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-muted-foreground')}>
                            {m ? `${m.moved_by > 0 ? '+' : ''}${formatUGX(m.moved_by)}` : 'unchanged'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
