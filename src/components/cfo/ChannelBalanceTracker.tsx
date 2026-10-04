import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Loader2, TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { formatUGX } from '@/lib/rentCalculations';
import { FINAL_WITHDRAWAL_STATUSES } from '@/lib/ledgerConstants';

const CHANNELS = [
  { key: 'mtn', label: 'MTN', color: 'bg-amber-500', emoji: '📱' },
  { key: 'airtel', label: 'Airtel', color: 'bg-red-500', emoji: '📲' },
  { key: 'bank', label: 'Bank', color: 'bg-blue-500', emoji: '🏦' },
  { key: 'cash', label: 'Cash', color: 'bg-emerald-500', emoji: '💵' },
  { key: 'unassigned', label: 'Unassigned Channel', color: 'bg-orange-400', emoji: '⚠️' },
];

export function ChannelBalanceTracker() {
  const { data: deposits = [], isLoading } = useQuery({
    queryKey: ['channel-deposits-tracker'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposit_requests')
        .select('amount, provider, status, created_at')
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data || [];
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const { data: withdrawals = [] } = useQuery({
    queryKey: ['channel-withdrawals-tracker'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('amount, payout_method, mobile_money_provider, status, created_at')
        .in('status', FINAL_WITHDRAWAL_STATUSES)
        .limit(200);
      if (error) throw error;
      return data || [];
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const channelData = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 86400000);

    return CHANNELS.map(ch => {
      const chDeposits = deposits.filter((d: any) => {
        const p = (d.provider || '').toLowerCase();
        if (ch.key === 'mtn') return p.includes('mtn');
        if (ch.key === 'airtel') return p.includes('airtel');
        if (ch.key === 'bank') return p.includes('bank');
        if (ch.key === 'cash') return p.includes('cash') || p.includes('agent') || p.includes('receipt');
        if (ch.key === 'unassigned') return !p || (!p.includes('mtn') && !p.includes('airtel') && !p.includes('bank') && !p.includes('cash') && !p.includes('agent') && !p.includes('receipt'));
        return false;
      });

      const chWithdrawals = withdrawals.filter((w: any) => {
        const m = (w.payout_method || '').toLowerCase();
        const p = (w.mobile_money_provider || '').toLowerCase();
        if (ch.key === 'mtn') return m.includes('mtn') || p.includes('mtn');
        if (ch.key === 'airtel') return m.includes('airtel') || p.includes('airtel');
        if (ch.key === 'bank') return m.includes('bank') || p.includes('bank');
        if (ch.key === 'cash') return m.includes('cash') || m.includes('agent') || p.includes('cash');
        if (ch.key === 'unassigned') {
          const matched = m.includes('mtn') || p.includes('mtn') || m.includes('airtel') || p.includes('airtel') || m.includes('bank') || p.includes('bank') || m.includes('cash') || m.includes('agent') || p.includes('cash');
          return !matched;
        }
        return false;
      });

      const totalIn = chDeposits.reduce((s: number, d: any) => s + Number(d.amount), 0);
      const totalOut = chWithdrawals.reduce((s: number, w: any) => s + Number(w.amount), 0);
      const netBalance = totalIn - totalOut;

      const todayIn = chDeposits
        .filter((d: any) => new Date(d.created_at) >= today)
        .reduce((s: number, d: any) => s + Number(d.amount), 0);

      const weekIn = chDeposits
        .filter((d: any) => new Date(d.created_at) >= weekAgo)
        .reduce((s: number, d: any) => s + Number(d.amount), 0);

      const prevWeekStart = new Date(weekAgo.getTime() - 7 * 86400000);
      const prevWeekIn = chDeposits
        .filter((d: any) => {
          const dt = new Date(d.created_at);
          return dt >= prevWeekStart && dt < weekAgo;
        })
        .reduce((s: number, d: any) => s + Number(d.amount), 0);

      const trend = prevWeekIn > 0 ? ((weekIn - prevWeekIn) / prevWeekIn) * 100 : 0;

      return { ...ch, totalIn, totalOut, netBalance, todayIn, weekIn, trend, txCount: chDeposits.length };
    });
  }, [deposits, withdrawals]);

  const grandTotal = channelData.reduce((s, c) => s + c.netBalance, 0);
  const unassignedChannel = channelData.find(c => c.key === 'unassigned');
  const hasUnassignedFunds = unassignedChannel && (unassignedChannel.netBalance !== 0 || unassignedChannel.txCount > 0);

  if (isLoading) {
    return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-2.5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Channels</h3>
        <span className="text-xs font-mono font-semibold text-muted-foreground">
          Net {formatUGX(grandTotal)}
        </span>
      </div>

      {/* Unassigned channel alert */}
      {hasUnassignedFunds && (
        <div className="flex items-center gap-2 rounded-lg border border-orange-300 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-800 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-orange-500 shrink-0" />
          <span className="text-[11px] text-orange-700 dark:text-orange-400">
            {formatUGX(Math.abs(unassignedChannel!.netBalance))} in unassigned channel — needs provider attribution
          </span>
        </div>
      )}

      {/* Channel rows — single column, clean list */}
      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        {channelData.map(ch => {
          // Hide unassigned row if it has no activity
          if (ch.key === 'unassigned' && ch.netBalance === 0 && ch.txCount === 0) return null;

          const TrendIcon = ch.trend > 5 ? TrendingUp : ch.trend < -5 ? TrendingDown : Minus;
          const trendColor = ch.trend > 5 ? 'text-emerald-500' : ch.trend < -5 ? 'text-destructive' : 'text-muted-foreground';

          return (
            <div key={ch.key} className="flex items-center gap-3 px-3 py-2.5">
              {/* Color dot + label */}
              <div className={`w-2 h-2 rounded-full shrink-0 ${ch.color}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">{ch.emoji} {ch.label}</span>
                  <span className="text-xs font-bold font-mono text-foreground">{formatUGX(ch.netBalance)}</span>
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    +{formatUGX(ch.todayIn)} today · {ch.txCount} txns
                  </span>
                  <span className={`flex items-center gap-0.5 text-[10px] font-medium ${trendColor}`}>
                    <TrendIcon className="h-2.5 w-2.5" />
                    {Math.abs(ch.trend).toFixed(0)}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
