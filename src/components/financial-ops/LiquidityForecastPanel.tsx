import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { CalendarClock, Wallet, TrendingDown, ChevronDown, ChevronRight, Loader2, Home } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Liquidity Forecast — a FinOps-only view showing:
 *  • Total withdrawable balance sitting across all user wallets right now
 *    (what could theoretically be pulled out today).
 *  • Upcoming ROI obligations bucketed by date for the next N days, so
 *    FinOps can pre-fund the pool BEFORE the payout crons fire.
 *  • Pending withdrawal requests already in the queue (near-term drain).
 *
 * Read-only. Actual "control" of withdrawable balances stays in the
 * dedicated tools: Float → Withdrawable, Manual Float Credit, Wallet Move.
 * Those are linked from the footer so a FinOps operator can jump straight
 * into the correction they need.
 */
export interface LiquidityForecastPanelProps {
  onOpenTool?: (t: string) => void;
}

const HORIZONS = [7, 14, 30, 60] as const;
type Horizon = (typeof HORIZONS)[number];

export function LiquidityForecastPanel({ onOpenTool }: LiquidityForecastPanelProps) {
  const [horizon, setHorizon] = useState<Horizon>(14);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [lpExpandedDate, setLpExpandedDate] = useState<string | null>(null);
  const windowLabel = `next ${horizon}d`;

  // ONE source of truth: every number below comes from the database function get_liquidity_forecast, which the mobile
  // app calls too, so the two can never disagree. Rules it applies: Kampala days; Saturday and Sunday ROI is paid with
  // Monday's (we do not pay partner rewards over the weekend); withdrawable = the wallets table; overdue payouts are
  // split into recent and stale (older than 30 days).
  const { data: forecast, isLoading } = useQuery({
    queryKey: ['finops-liquidity-forecast', horizon],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_liquidity_forecast' as any, { p_days: horizon });
      if (error) throw error;
      return data as any;
    },
  });

  const withdrawableTotals = forecast?.withdrawable as { total: number; wallets: number; ledger_total: number; gap_vs_ledger: number } | undefined;
  const pendingDrain = forecast?.pending_withdrawals as { total: number; count: number } | undefined;
  const overdue = forecast?.overdue_payouts as
    | { recent_total: number; recent_count: number; stale_total: number; stale_count: number; total: number; count: number }
    | undefined;
  const today: string = forecast?.today ?? '';

  // The list of portfolios behind a day is fetched only when that day is opened. Saturday and Sunday ROI belongs to
  // the Monday it is paid on, so a Monday also loads the two days before it.
  const { data: roiDetail } = useQuery({
    queryKey: ['finops-liquidity-roi-rows', expandedDate],
    enabled: !!expandedDate,
    staleTime: 60_000,
    queryFn: async () => {
      const payDate = expandedDate as string;
      const start = new Date(`${payDate}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 2);
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, portfolio_code, account_name, investment_amount, roi_percentage, roi_mode, next_roi_date, auto_reinvest')
        .eq('status', 'active')
        .gte('next_roi_date', start.toISOString().slice(0, 10))
        .lte('next_roi_date', payDate)
        .order('next_roi_date', { ascending: true })
        .limit(2000);
      if (error) throw error;
      const payDateOf = (d: string) => {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 6 = Saturday, 0 = Sunday
        const add = dow === 6 ? 2 : dow === 0 ? 1 : 0;
        const x = new Date(`${d}T00:00:00Z`);
        x.setUTCDate(x.getUTCDate() + add);
        return x.toISOString().slice(0, 10);
      };
      return (data || [])
        .filter((r: any) => payDateOf(String(r.next_roi_date)) === payDate)
        .map((r: any) => ({
          ...r,
          roi_amount: Math.round((Number(r.investment_amount || 0) * Number(r.roi_percentage || 0)) / 100),
        }));
    },
  });

  const { data: lpDetail } = useQuery({
    queryKey: ['finops-liquidity-lp-rows', lpExpandedDate],
    enabled: !!lpExpandedDate,
    staleTime: 60_000,
    queryFn: async () => {
      const day = lpExpandedDate as string;
      // A Kampala day runs from 00:00 to 24:00 at UTC+3.
      const start = new Date(`${day}T00:00:00+03:00`);
      const end = new Date(start.getTime() + 86_400_000);
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select('id, landlord_name, landlord_phone, amount, status, sla_deadline, mobile_money_provider')
        .in('status', ['pending_merchant_payout', 'awaiting_agent_receipt', 'failed', 'pending', 'queued'])
        .gte('sla_deadline', start.toISOString())
        .lt('sla_deadline', end.toISOString())
        .order('sla_deadline', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return data || [];
    },
  });

  const byDate = useMemo(
    () =>
      ((forecast?.roi_days as any[]) || []).map((d) => ({
        date: String(d.date),
        total: Number(d.total),
        cashout: Number(d.cashout),
        reinvest: Number(d.reinvest),
        weekend: Number(d.rolled_from_weekend || 0),
        count: Number(d.portfolios),
        rows: expandedDate === String(d.date) ? roiDetail || [] : [],
      })),
    [forecast, expandedDate, roiDetail],
  );

  const totals = useMemo(
    () =>
      byDate.reduce(
        (acc, b) => ({ total: acc.total + b.total, cashout: acc.cashout + b.cashout, reinvest: acc.reinvest + b.reinvest }),
        { total: 0, cashout: 0, reinvest: 0 },
      ),
    [byDate],
  );
  const maxDay = Math.max(1, ...byDate.map((b) => b.total));

  const lpByDate = useMemo(
    () =>
      ((forecast?.landlord_payout_days as any[]) || []).map((d) => ({
        date: String(d.date),
        total: Number(d.total),
        count: Number(d.payouts),
        rows: lpExpandedDate === String(d.date) ? lpDetail || [] : [],
      })),
    [forecast, lpExpandedDate, lpDetail],
  );
  const lpTotal = useMemo(() => lpByDate.reduce((s, b) => s + b.total, 0), [lpByDate]);
  const lpCount = useMemo(() => lpByDate.reduce((s, b) => s + b.count, 0), [lpByDate]);
  const lpMaxDay = Math.max(1, ...lpByDate.map((b) => b.total));
  const roiLoading = isLoading;
  const lpLoading = isLoading;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <CalendarClock className="h-6 w-6 text-primary" />
          Liquidity Forecast
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          What the pool owes on each upcoming day, and how much is sitting withdrawable right now.
          Use this to pre-fund before ROI crons run.
        </p>
      </div>

      {/* Top strip — three numbers that matter today. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Wallet className="h-3.5 w-3.5" /> Withdrawable in wallets
          </div>
          <p className="mt-2 text-xl font-bold">{formatUGX(withdrawableTotals?.total ?? 0)}</p>
          <p className="text-[11px] text-muted-foreground">
            across {withdrawableTotals?.wallets ?? 0} wallets
          </p>
          {withdrawableTotals && Math.abs(withdrawableTotals.gap_vs_ledger) >= 1 && (
            <p className="text-[10px] text-muted-foreground mt-1">
              Ledger view says {formatUGX(withdrawableTotals.ledger_total)}; the difference is balances with no wallet row.
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <TrendingDown className="h-3.5 w-3.5" /> Pending withdrawal queue
          </div>
          <p className="mt-2 text-xl font-bold">{formatUGX(pendingDrain?.total ?? 0)}</p>
          <p className="text-[11px] text-muted-foreground">
            {pendingDrain?.count ?? 0} requests awaiting settlement
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" /> ROI due ({windowLabel})
          </div>
          <p className="mt-2 text-xl font-bold">{formatUGX(totals.cashout)}</p>
          <p className="text-[11px] text-muted-foreground">
            + {formatUGX(totals.reinvest)} auto-reinvest (no cash-out)
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Home className="h-3.5 w-3.5" /> Landlord payout float ({windowLabel})
          </div>
          <p className="mt-2 text-xl font-bold">{formatUGX(lpTotal)}</p>
          <p className="text-[11px] text-muted-foreground">
            {lpCount} payouts due
            {overdue && overdue.count > 0 && (
              <>
                {' '}· <span className="text-red-600 font-semibold">{formatUGX(overdue.recent_total)} overdue</span>
                {overdue.stale_count > 0 && (
                  <span className="text-muted-foreground"> + {formatUGX(overdue.stale_total)} older than 30 days</span>
                )}
              </>
            )}
          </p>
        </div>
      </div>

      {/* Horizon */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Horizon</span>
        <div className="flex gap-1">
          {HORIZONS.map((h) => (
            <button
              key={h}
              onClick={() => {
                setHorizon(h);
                setExpandedDate(null);
                setLpExpandedDate(null);
              }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                horizon === h ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-muted/70',
              )}
            >
              {h}d
            </button>
          ))}
        </div>
      </div>

      {/* Per-day list with bar */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-bold">ROI obligations by day</h3>
          <span className="text-[11px] text-muted-foreground">Cash-out only counts toward pool drain</span>
        </div>
        {roiLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading forecast…
          </div>
        ) : byDate.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No ROI payouts scheduled in the next {horizon} days.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {byDate.map((b) => {
              const pct = Math.round((b.total / maxDay) * 100);
              const isOpen = expandedDate === b.date;
              const dayLabel = new Date(b.date).toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              });
              return (
                <li key={b.date}>
                  <button
                    type="button"
                    onClick={() => setExpandedDate(isOpen ? null : b.date)}
                    className="w-full text-left px-4 py-3 hover:bg-muted/40 transition"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex items-center gap-2">
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="text-sm font-semibold">{dayLabel}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {b.count} portfolio{b.count === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold">{formatUGX(b.cashout)}</p>
                        {b.reinvest > 0 && (
                          <p className="text-[10px] text-muted-foreground">
                            +{formatUGX(b.reinvest)} reinvest
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {b.weekend > 0 && (
                      <p className="mt-1.5 text-[10px] text-muted-foreground">
                        Includes {formatUGX(b.weekend)} due Saturday and Sunday: partner ROI is not paid over the weekend.
                      </p>
                    )}
                  </button>
                  {isOpen && (
                    <div className="bg-muted/30 px-4 py-3">
                      <table className="w-full text-xs">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="text-left py-1 font-semibold">Portfolio</th>
                            <th className="text-left py-1 font-semibold">Account</th>
                            <th className="text-right py-1 font-semibold">Principal</th>
                            <th className="text-right py-1 font-semibold">ROI</th>
                            <th className="text-left py-1 pl-3 font-semibold">Mode</th>
                          </tr>
                        </thead>
                        <tbody>
                          {b.rows.map((r: any) => (
                            <tr key={r.id} className="border-t border-border/60">
                              <td className="py-1.5 font-mono text-[11px]">{r.portfolio_code || r.id.slice(0, 8)}</td>
                              <td className="py-1.5 truncate max-w-[180px]">{r.account_name || '—'}</td>
                              <td className="py-1.5 text-right">{formatUGX(r.investment_amount)}</td>
                              <td className="py-1.5 text-right font-semibold">{formatUGX(r.roi_amount)}</td>
                              <td className="py-1.5 pl-3">
                                {r.auto_reinvest || r.roi_mode === 'compounding' ? (
                                  <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                                    Reinvest
                                  </span>
                                ) : (
                                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                    Cash-out
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Landlord Payout Float — obligations by day */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Home className="h-4 w-4 text-primary" /> Agent → Landlord payout float
          </h3>
          <span className="text-[11px] text-muted-foreground">Rent already collected, payout still owed to landlord</span>
        </div>
        {lpLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading landlord payout float…
          </div>
        ) : lpByDate.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No landlord payouts scheduled in this window.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {lpByDate.map((b) => {
              const pct = Math.round((b.total / lpMaxDay) * 100);
              const isOpen = lpExpandedDate === b.date;
              const dayLabel = new Date(b.date).toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              });
              // Compared against today in Kampala, as worked out by the database.
              const isOverdue = !!today && b.date < today;
              return (
                <li key={b.date}>
                  <button
                    type="button"
                    onClick={() => setLpExpandedDate(isOpen ? null : b.date)}
                    className="w-full text-left px-4 py-3 hover:bg-muted/40 transition"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex items-center gap-2">
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className={cn('text-sm font-semibold', isOverdue && 'text-red-600')}>
                          {dayLabel}{isOverdue ? ' (overdue)' : ''}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {b.count} payout{b.count === 1 ? '' : 's'}
                        </span>
                      </div>
                      <p className="text-sm font-bold">{formatUGX(b.total)}</p>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn('h-full', isOverdue ? 'bg-red-500' : 'bg-primary')}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                  {isOpen && (
                    <div className="bg-muted/30 px-4 py-3 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="text-left py-1 font-semibold">Landlord</th>
                            <th className="text-left py-1 font-semibold">Phone</th>
                            <th className="text-left py-1 font-semibold">Provider</th>
                            <th className="text-left py-1 font-semibold">Status</th>
                            <th className="text-right py-1 font-semibold">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {b.rows.map((r: any) => (
                            <tr key={r.id} className="border-t border-border/60">
                              <td className="py-1.5 truncate max-w-[180px]">{r.landlord_name || '—'}</td>
                              <td className="py-1.5 font-mono text-[11px]">{r.landlord_phone || '—'}</td>
                              <td className="py-1.5">{r.mobile_money_provider || '—'}</td>
                              <td className="py-1.5">
                                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                  {String(r.status).replace(/_/g, ' ')}
                                </span>
                              </td>
                              <td className="py-1.5 text-right font-semibold">{formatUGX(Number(r.amount || 0))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Control shortcuts */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-bold">Control withdrawable balances</h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          If a wallet needs to be re-bucketed before payout, jump to the right tool:
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => onOpenTool?.('float_to_withdrawable')}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-muted transition"
          >
            Float → Withdrawable
          </button>
          <button
            onClick={() => onOpenTool?.('manual_float_credit')}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-muted transition"
          >
            Manual Float Credit
          </button>
          <button
            onClick={() => onOpenTool?.('wallet_breakdown')}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-muted transition"
          >
            Wallet Move / Breakdown
          </button>
          <button
            onClick={() => onOpenTool?.('user_statements')}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-muted transition"
          >
            User Wallet Statements
          </button>
        </div>
      </div>
    </div>
  );
}

export default LiquidityForecastPanel;