import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { PieChart as PieIcon, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';

const SINCE = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const compactUGX = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
};

/** One revenue stream with current + prior 30-day windows. */
type Stream = {
  key: string;
  label: string;
  color: string;
  current: number;
  prior: number;
};

const STREAM_COLORS: Record<string, string> = {
  access: 'hsl(var(--primary))',
  platform: 'hsl(160 60% 45%)',
  cash: 'hsl(180 55% 40%)',
  commission: 'hsl(345 70% 55%)',
};

/**
 * Revenue Mix by Stream + Top Drivers
 *
 * Donut of the current 30-day revenue split by stream, alongside a driver
 * breakdown that ranks which streams moved revenue the most versus the prior
 * 30 days (28→56 day window).
 */
export function RevenueMixDrivers() {
  const { data, isLoading } = useQuery({
    queryKey: ['ceo-revenue-mix-drivers'],
    staleTime: 600000,
    queryFn: async () => {
      // fee ledger split by type across the two windows
      const { data: feeRows } = await supabase
        .from('fee_revenue_ledger')
        .select('fee_type, total_amount, created_at')
        .gte('created_at', SINCE(60))
        .limit(20000);
      const fees = feeRows || [];
      const cut30 = SINCE(30);
      const sumFees = (type: 'access' | 'other', window: 'cur' | 'prior') =>
        fees
          .filter((r) => {
            const isAccess = r.fee_type === 'access_fee';
            const matchType = type === 'access' ? isAccess : !isAccess;
            const inCur = r.created_at >= cut30;
            return matchType && (window === 'cur' ? inCur : !inCur);
          })
          .reduce((s, r) => s + Number(r.total_amount || 0), 0);

      // general ledger cash streams across the two windows
      const grabLedger = async (categories: string[]) => {
        const { data } = await supabase
          .from('general_ledger')
          .select('amount, created_at')
          .in('category', categories)
          .eq('direction', 'cash_in')
          .neq('classification', 'admin_correction')
          .gte('created_at', SINCE(60))
          .limit(20000);
        const rows = data || [];
        const cur = rows.filter((r) => r.created_at >= cut30).reduce((s, r) => s + Number(r.amount || 0), 0);
        const prior = rows.filter((r) => r.created_at < cut30).reduce((s, r) => s + Number(r.amount || 0), 0);
        return { cur, prior };
      };
      const [cash, commission] = await Promise.all([
        grabLedger(['access_fee_collected', 'tenant_access_fee', 'registration_fee_collected']),
        grabLedger(['agent_commission_earned', 'agent_commission']),
      ]);

      const streams: Stream[] = [
        { key: 'access', label: 'Access fee', color: STREAM_COLORS.access, current: sumFees('access', 'cur'), prior: sumFees('access', 'prior') },
        { key: 'platform', label: 'Platform fee', color: STREAM_COLORS.platform, current: sumFees('other', 'cur'), prior: sumFees('other', 'prior') },
        { key: 'cash', label: 'Cash fees collected', color: STREAM_COLORS.cash, current: cash.cur, prior: cash.prior },
        { key: 'commission', label: 'Agent commission', color: STREAM_COLORS.commission, current: commission.cur, prior: commission.prior },
      ];

      const totalCur = streams.reduce((s, r) => s + r.current, 0);
      const totalPrior = streams.reduce((s, r) => s + r.prior, 0);
      const drivers = streams
        .map((s) => ({ ...s, delta: s.current - s.prior }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      return { streams, drivers, totalCur, totalPrior, netChange: totalCur - totalPrior };
    },
  });

  const streams = (data?.streams || []).filter((s) => s.current > 0);
  const drivers = data?.drivers || [];
  const totalCur = data?.totalCur || 0;
  const netChange = data?.netChange || 0;
  const changePct = data?.totalPrior ? Math.round((netChange / data.totalPrior) * 100) : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
      {/* Mix donut */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="flex items-center gap-2 mb-3">
          <PieIcon className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-semibold">Revenue Mix by Stream (30d)</h4>
        </div>
        {isLoading ? (
          <div className="h-[220px] w-full bg-muted animate-pulse rounded-xl" />
        ) : streams.length === 0 ? (
          <p className="text-xs text-muted-foreground h-[220px] flex items-center justify-center">No revenue in the last 30 days.</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={streams} dataKey="current" nameKey="label" innerRadius={55} outerRadius={85} paddingAngle={2}>
                {streams.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number) => formatUGX(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
        <p className="text-center text-xs text-muted-foreground mt-1">
          Total <span className="font-bold text-foreground">{formatUGX(totalCur)}</span>
        </p>
      </div>

      {/* Top drivers */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h4 className="text-sm font-semibold">Top Drivers · 30d Change</h4>
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full',
              netChange > 0 ? 'bg-emerald-500/10 text-emerald-600'
                : netChange < 0 ? 'bg-rose-500/10 text-rose-600' : 'bg-muted text-muted-foreground',
            )}
          >
            {netChange > 0 ? <TrendingUp className="h-3 w-3" /> : netChange < 0 ? <TrendingDown className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
            {netChange >= 0 ? '+' : ''}{formatUGX(netChange)} ({changePct >= 0 ? '+' : ''}{changePct}%)
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground mb-3">Last 30 days vs the prior 30 days</p>
        <div className="space-y-2.5">
          {isLoading &&
            [0, 1, 2, 3].map((i) => <div key={i} className="h-9 w-full bg-muted animate-pulse rounded-lg" />)}
          {!isLoading &&
            drivers.map((d) => {
              const up = d.delta > 0;
              const flat = d.delta === 0;
              return (
                <div key={d.key} className="flex items-center gap-3">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium truncate">{d.label}</span>
                      <span
                        className={cn(
                          'text-xs font-bold shrink-0 inline-flex items-center gap-0.5',
                          up ? 'text-emerald-600' : flat ? 'text-muted-foreground' : 'text-rose-600',
                        )}
                      >
                        {up ? <TrendingUp className="h-3 w-3" /> : flat ? <Minus className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {d.delta >= 0 ? '+' : ''}{compactUGX(d.delta)}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {formatUGX(d.prior)} → {formatUGX(d.current)}
                    </p>
                  </div>
                </div>
              );
            })}
        </div>
        {!isLoading && drivers[0] && Math.abs(drivers[0].delta) > 0 && (
          <p className="text-[11px] text-muted-foreground mt-3 pt-3 border-t border-border">
            Biggest mover:{' '}
            <span className="font-semibold text-foreground">{drivers[0].label}</span>{' '}
            {drivers[0].delta >= 0 ? 'added' : 'lost'}{' '}
            <span className={cn('font-semibold', drivers[0].delta >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
              {formatUGX(Math.abs(drivers[0].delta))}
            </span>{' '}
            vs the prior period.
          </p>
        )}
      </div>
    </div>
  );
}