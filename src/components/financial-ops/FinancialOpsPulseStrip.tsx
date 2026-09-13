import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ArrowDownToLine, ArrowUpFromLine, Activity, AlertTriangle, RefreshCw, Banknote, ChevronRight } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';

export type PulseMetricKey = 'deposits' | 'cash_out' | 'today' | 'wallet_ops' | 'invest_wd';

interface PulseMetric {
  key: PulseMetricKey;
  label: string;
  value: number;
  amount?: number;
  icon: typeof Activity;
  color: string;
  bgColor: string;
}

export function FinancialOpsPulseStrip({ onSelect }: { onSelect?: (key: PulseMetricKey) => void } = {}) {
  const { data: metrics, isLoading, refetch } = useQuery({
    queryKey: ['financial-ops-pulse'],
    queryFn: async () => {
      // Single RPC call instead of 5 separate queries - handles 1M+ scale
      const { data, error } = await supabase.rpc('get_financial_ops_pulse');
      if (error) throw error;
      const d = data as any;
      return {
        pendingDeposits: d.pending_deposits,
        pendingWithdrawals: d.pending_withdrawals,
        pendingWalletWithdrawals: d.pending_wallet_withdrawals,
        pendingWalletOps: d.pending_wallet_ops,
        todayVolume: d.today_volume,
      };
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const pulseItems: PulseMetric[] = [
    {
      key: 'deposits',
      label: 'Deposits',
      value: metrics?.pendingDeposits.count || 0,
      amount: metrics?.pendingDeposits.amount,
      icon: ArrowDownToLine,
      color: 'text-primary',
      bgColor: 'bg-primary/10',
    },
    {
      key: 'cash_out',
      label: 'Cash Out',
      value: metrics?.pendingWalletWithdrawals.count || 0,
      amount: metrics?.pendingWalletWithdrawals.amount,
      icon: Banknote,
      color: 'text-destructive',
      bgColor: 'bg-destructive/10',
    },
    {
      key: 'today',
      label: "Today",
      value: metrics?.todayVolume.count || 0,
      amount: metrics?.todayVolume.amount,
      icon: Activity,
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-500/10',
    },
    {
      key: 'wallet_ops',
      label: 'Wallet Ops',
      value: metrics?.pendingWalletOps.count || 0,
      amount: metrics?.pendingWalletOps.amount,
      icon: AlertTriangle,
      color: 'text-amber-600',
      bgColor: 'bg-amber-500/10',
    },
    {
      key: 'invest_wd',
      label: 'Invest W/D',
      value: metrics?.pendingWithdrawals.count || 0,
      amount: metrics?.pendingWithdrawals.amount,
      icon: ArrowUpFromLine,
      color: 'text-muted-foreground',
      bgColor: 'bg-muted',
    },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Pulse Monitor</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} className="h-7 px-2.5 gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3 w-3" />
          <span>Refresh</span>
        </Button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
        {pulseItems.map((item) => {
          const Icon = item.icon;
          const isUrgent = item.value > 0 && item.label !== 'Today';
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => onSelect?.(item.key)}
              className={`group text-left rounded-xl border p-2.5 sm:p-3 transition-all hover:shadow-xs active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                isUrgent ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60' : 'border-border bg-card hover:border-primary/40'
              }`}
            >
              <div className="flex items-center justify-between gap-1 mb-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className={`p-1 rounded-md shrink-0 ${item.bgColor}`}>
                    <Icon className={`h-3.5 w-3.5 ${item.color}`} />
                  </div>
                  <span className="text-[11px] text-muted-foreground font-semibold truncate">{item.label}</span>
                </div>
                <ChevronRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" />
              </div>
              <p className={`text-xl sm:text-2xl font-black tabular-nums tracking-tight text-foreground truncate ${isLoading ? 'animate-pulse' : ''}`}>
                {isLoading ? '—' : item.value.toLocaleString()}
              </p>
              {item.amount !== undefined && item.amount > 0 ? (
                <p className="text-[11px] text-muted-foreground font-mono font-medium mt-0.5 truncate">
                  {formatUGX(item.amount)}
                </p>
              ) : (
                <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">
                  {item.label === 'Today' ? 'Volume today' : 'Pending'}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
