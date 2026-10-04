import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { PieChart, AlertTriangle } from 'lucide-react';

interface SourceRow {
  source_key: string;
  source_label: string;
  amount: number;
  txn_count: number;
  pct: number;
  is_adjustment: boolean;
}

const BAR_TONE: Record<string, string> = {
  commission: 'bg-emerald-500',
  deposit: 'bg-primary',
  transfer_in: 'bg-sky-500',
  referral: 'bg-violet-500',
  returns: 'bg-amber-500',
  bonus: 'bg-teal-500',
  collections: 'bg-indigo-500',
  advance: 'bg-orange-500',
  adjustment: 'bg-destructive',
  other: 'bg-muted-foreground',
};

/**
 * Read-only funding-source composition for a user's withdrawable balance.
 * Purely an indicator: it never moves money, never edits ledger rows and
 * never touches the withdrawal request itself.
 */
export function WithdrawalSourceIndicator({ userId, lookbackDays = 365 }: { userId: string | null; lookbackDays?: number }) {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    setLoading(true);
    supabase
      .rpc('get_withdrawal_source_breakdown', { p_user_id: userId, p_lookback_days: lookbackDays })
      .then(({ data }) => {
        if (!active) return;
        setRows(((data as SourceRow[]) || []).map(r => ({ ...r, amount: Number(r.amount), pct: Number(r.pct) })));
        setLoading(false);
      });
    return () => { active = false; };
  }, [userId, lookbackDays]);

  if (!userId) return null;
  if (loading) return <Skeleton className="h-24 w-full rounded-2xl" />;
  if (rows.length === 0) return null;

  const dominant = rows[0];
  const adjustment = rows.find(r => r.is_adjustment);

  return (
    <div className="rounded-2xl border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold flex items-center gap-2">
          <PieChart className="h-3.5 w-3.5 text-primary" />
          Funding source mix
        </p>
        <span className="text-[10px] text-muted-foreground">last {lookbackDays}d</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Likely source</span>
        <span className="text-xs font-semibold">
          {dominant.source_label} · {dominant.pct}%
        </span>
      </div>

      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {rows.map(r => (
          <div
            key={r.source_key}
            className={BAR_TONE[r.source_key] || 'bg-muted-foreground'}
            style={{ width: `${Math.max(r.pct, 0.5)}%` }}
            title={`${r.source_label}: ${r.pct}%`}
          />
        ))}
      </div>

      <div className="space-y-1">
        {rows.map(r => (
          <div key={r.source_key} className="flex items-center gap-2 text-xs">
            <span className={`h-2 w-2 shrink-0 rounded-full ${BAR_TONE[r.source_key] || 'bg-muted-foreground'}`} />
            <span className="flex-1 truncate text-muted-foreground">
              {r.source_label} <span className="text-[10px]">({r.txn_count})</span>
            </span>
            <span className="font-mono tabular-nums font-medium">{formatUGX(r.amount)}</span>
            <span className="w-10 text-right text-[10px] text-muted-foreground tabular-nums">{r.pct}%</span>
          </div>
        ))}
      </div>

      {adjustment && (
        <p className="text-[10px] text-destructive flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          {adjustment.pct}% of credited value comes from admin adjustments / reseeds — verify before payout.
        </p>
      )}

      <p className="text-[10px] text-muted-foreground">
        Attribution is based on ledger credit history into the withdrawable bucket. Balances are fungible, so this is a
        composition indicator, not a trace of specific funds.
      </p>
    </div>
  );
}
