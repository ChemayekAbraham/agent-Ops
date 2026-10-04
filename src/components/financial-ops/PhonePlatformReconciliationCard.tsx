import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { Smartphone, Wallet, CheckCircle2, AlertTriangle, Landmark } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';

interface PhonePlatformReconciliationCardProps {
  /**
   * Compact mode (Overview) shows only the two headline totals and the
   * status badge. Full mode (Reconciliation tool tab) adds the per-channel
   * MTN/Airtel breakdown with a "last SMS seen" timestamp for each line.
   */
  compact?: boolean;
}

interface ReconciliationData {
  mtnBalance: number;
  mtnLastSmsAt: string | null;
  airtelBalance: number;
  airtelLastSmsAt: string | null;
  phoneTotal: number;
  platformTotal: number;
  expectedPhoneTotal: number;
  gapAmount: number;
  isOnTarget: boolean;
}

export function PhonePlatformReconciliationCard({ compact = false }: PhonePlatformReconciliationCardProps) {
  const autoRefresh = useFinOpsAutoRefresh();

  const { data, isLoading } = useQuery({
    queryKey: ['finops-phone-platform-reconciliation'],
    queryFn: async (): Promise<ReconciliationData> => {
      const { data, error } = await supabase.rpc('get_phone_platform_reconciliation' as any);
      if (error) throw error;
      const d = data as any;
      return {
        mtnBalance: Number(d.mtn_balance ?? 0),
        mtnLastSmsAt: d.mtn_last_sms_at ?? null,
        airtelBalance: Number(d.airtel_balance ?? 0),
        airtelLastSmsAt: d.airtel_last_sms_at ?? null,
        phoneTotal: Number(d.phone_total ?? 0),
        platformTotal: Number(d.platform_total ?? 0),
        expectedPhoneTotal: Number(d.expected_phone_total ?? 0),
        gapAmount: Number(d.gap_amount ?? 0),
        isOnTarget: !!d.is_on_target,
      };
    },
    staleTime: 60_000,
    refetchInterval: autoRefresh ? 60_000 : false,
  });

  const shortfall = Math.max(0, -(data?.gapAmount ?? 0));

  return (
    <div className="rounded-2xl border border-border bg-card p-5 sm:p-6 h-full">
      <div className="flex items-center justify-between gap-2 mb-3 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
            <Smartphone className="h-5 w-5 text-primary" />
          </div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
            Phone Money vs Platform Money
          </p>
        </div>
        {isLoading ? null : data?.isOnTarget ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 shrink-0">
            <CheckCircle2 className="h-3 w-3" /> On Target
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 shrink-0">
            <AlertTriangle className="h-3 w-3" /> Needs Top-Up
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-muted/40 border border-border p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            <Smartphone className="h-3 w-3" /> Real Money on Phone
          </div>
          <p className="text-lg sm:text-xl font-black tabular-nums mt-1 text-foreground break-all">
            {isLoading ? '—' : formatUGX(data?.phoneTotal ?? 0)}
          </p>
        </div>
        <div className="rounded-xl bg-muted/40 border border-border p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            <Wallet className="h-3 w-3" /> Platform Money
          </div>
          <p className="text-lg sm:text-xl font-black tabular-nums mt-1 text-foreground break-all">
            {isLoading ? '—' : formatUGX(data?.platformTotal ?? 0)}
          </p>
        </div>
      </div>

      {!isLoading && !data?.isOnTarget && (
        <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400">
          Phone is short of the 50% target by <span className="font-semibold">{formatUGX(shortfall)}</span> — top up the merchant lines when convenient.
        </p>
      )}
      {!isLoading && data?.isOnTarget && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Target: phone money should sit at ~50% of platform money ({formatUGX(data?.expectedPhoneTotal ?? 0)}).
        </p>
      )}

      {!compact && (
        <div className="mt-4 pt-4 border-t border-border grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-background border border-border p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              <Landmark className="h-3 w-3" /> MTN (090777)
            </div>
            <p className="text-base font-bold tabular-nums mt-1 text-foreground break-all">
              {isLoading ? '—' : formatUGX(data?.mtnBalance ?? 0)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {isLoading
                ? '—'
                : data?.mtnLastSmsAt
                  ? `Last SMS ${formatDistanceToNow(new Date(data.mtnLastSmsAt), { addSuffix: true })}`
                  : 'No balance SMS yet'}
            </p>
          </div>
          <div className="rounded-xl bg-background border border-border p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              <Landmark className="h-3 w-3" /> Airtel (4380664)
            </div>
            <p className="text-base font-bold tabular-nums mt-1 text-foreground break-all">
              {isLoading ? '—' : formatUGX(data?.airtelBalance ?? 0)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {isLoading
                ? '—'
                : data?.airtelLastSmsAt
                  ? `Last SMS ${formatDistanceToNow(new Date(data.airtelLastSmsAt), { addSuffix: true })}`
                  : 'No balance SMS yet'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
