import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { Loader2, TrendingUp, TrendingDown, ArrowRight, Wallet } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays, startOfDay } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';

export function DailyCashPositionReport() {
  const { data, isLoading } = useQuery({
    queryKey: ['daily-cash-position'],
    queryFn: async () => {
      const today = new Date();
      const days: any[] = [];

      // Get last 7 days of PLATFORM ledger data only
      const startDate = startOfDay(subDays(today, 6)).toISOString();
      const { data: ledger, error } = await supabase
        .from('general_ledger')
        .select('amount, direction, transaction_date')
        .gte('transaction_date', startDate)
        .eq('ledger_scope', 'platform')
        .in('classification', ['production', 'legacy_real']);
      if (error) throw error;

      // Platform cash via server-side RPC (no row limit)
      const [cashSummaryRes, walletTotalsRes, pendingRentRes] = await Promise.all([
        supabase.rpc('get_platform_cash_summary'),
        supabase.rpc('get_wallet_totals'),
        supabase.from('rent_requests')
          .select('rent_amount')
          .in('status', ['coo_approved', 'cfo_approved']),
      ]);

      const cashSummary = cashSummaryRes.data as any;
      const rev = Number(cashSummary?.total_revenue ?? 0);
      const costs = Number(cashSummary?.total_costs ?? 0);
      const platformCash = Math.max(0, rev - costs);

      // User funds held in custody (all wallets, no row limit)
      const walletTotals = walletTotalsRes.data as any;
      const userFundsCustody = Number(walletTotals?.total_balance ?? 0);

      // Get pending obligations
      const pendingObligations = (pendingRentRes.data || []).reduce((s, r) => s + r.rent_amount, 0);

      // Aggregate by day (platform scope only)
      for (let i = 6; i >= 0; i--) {
        const d = subDays(today, i);
        const dateStr = format(d, 'yyyy-MM-dd');
        const dayEntries = (ledger || []).filter(e => e.transaction_date?.startsWith(dateStr));
        const inflows = dayEntries.filter(e => e.direction === 'cash_in').reduce((s, e) => s + e.amount, 0);
        const outflows = dayEntries.filter(e => e.direction === 'cash_out').reduce((s, e) => s + e.amount, 0);
        days.push({
          date: format(d, 'dd MMM'),
          dateStr,
          inflows,
          outflows,
          net: inflows - outflows,
        });
      }

      const todayData = days[days.length - 1];
      return { days, platformCash, userFundsCustody, pendingObligations, today: todayData };
    },
    staleTime: 60_000,
  });

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!data) return null;

  const { days, platformCash, userFundsCustody, pendingObligations, today } = data;
  const availablePlatformCash = platformCash - pendingObligations;

  return (
    <div className="space-y-4">
      {/* Top KPI row */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="border-2 border-primary/20">
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Platform Cash</p>
            <p className="text-xl font-bold font-mono text-primary">{formatUGX(platformCash)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Earned revenue only</p>
          </CardContent>
        </Card>
        <Card className="border-2 border-warning/20">
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">User Funds (Custody)</p>
            <p className="text-xl font-bold font-mono text-warning">{formatUGX(userFundsCustody)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Not platform money</p>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Pending Obligations</p>
            <p className="text-xl font-bold font-mono text-destructive">{formatUGX(pendingObligations)}</p>
          </CardContent>
        </Card>
        <Card className={cn('border-2', availablePlatformCash < 0 ? 'border-destructive/30' : 'border-success/30')}>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Available Platform</p>
            <p className={cn('text-xl font-bold font-mono', availablePlatformCash < 0 ? 'text-destructive' : 'text-success')}>{formatUGX(availablePlatformCash)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Today's platform snapshot */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Platform Cash Flow — {format(new Date(), 'dd MMMM yyyy')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-around py-4">
            <div className="text-center">
              <p className="text-xs text-muted-foreground uppercase">Platform Inflows</p>
              <p className="text-lg font-bold text-success font-mono">{formatUGX(today.inflows)}</p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <div className="text-center">
              <p className="text-xs text-muted-foreground uppercase">Platform Outflows</p>
              <p className="text-lg font-bold text-destructive font-mono">{formatUGX(today.outflows)}</p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <div className="text-center">
              <p className="text-xs text-muted-foreground uppercase">Net</p>
              <p className={cn('text-lg font-bold font-mono', today.net >= 0 ? 'text-success' : 'text-destructive')}>
                {today.net >= 0 ? '+' : ''}{formatUGX(today.net)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 7-Day Chart */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">7-Day Platform Cash Flow Trend</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={days}>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
              <RechartsTooltip formatter={(v: number) => formatUGX(v)} />
              <Bar dataKey="inflows" fill="hsl(var(--success))" radius={[4, 4, 0, 0]} name="Platform Inflows" />
              <Bar dataKey="outflows" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} name="Platform Outflows" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
