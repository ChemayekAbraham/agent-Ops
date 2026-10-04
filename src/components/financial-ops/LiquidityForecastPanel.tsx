import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { CalendarClock, Wallet, TrendingDown, ChevronDown, ChevronRight, Loader2, CalendarIcon, Home, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';

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
  const [dateRange, setDateRange] = useState<DateRange | undefined>();

  // Effective window: custom range overrides horizon.
  const window = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dateRange?.from) {
      const from = new Date(dateRange.from);
      from.setHours(0, 0, 0, 0);
      const to = new Date(dateRange.to ?? dateRange.from);
      to.setHours(23, 59, 59, 999);
      return { from, to, custom: true as const };
    }
    const to = new Date(today);
    to.setDate(to.getDate() + horizon);
    to.setHours(23, 59, 59, 999);
    return { from: today, to, custom: false as const };
  }, [dateRange, horizon]);

  const fromDateStr = window.from.toISOString().slice(0, 10);
  const toDateStr = window.to.toISOString().slice(0, 10);
  const windowLabel = window.custom
    ? `${format(window.from, 'MMM d')} → ${format(window.to, 'MMM d')}`
    : `next ${horizon}d`;

  // Total withdrawable currently parked across all wallets.
  const { data: withdrawableTotals } = useQuery({
    queryKey: ['finops-liquidity-withdrawable'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('wallets')
        .select('withdrawable_balance')
        .gt('withdrawable_balance', 0);
      if (error) throw error;
      const total = (data || []).reduce((s: number, r: any) => s + Number(r.withdrawable_balance || 0), 0);
      return { total, wallets: (data || []).length };
    },
  });

  // Pending withdrawal drain in the queue (already requested, not settled).
  const { data: pendingDrain } = useQuery({
    queryKey: ['finops-liquidity-pending-drain'],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('amount, status')
        .in('status', ['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved']);
      if (error) throw error;
      const total = (data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      return { total, count: (data || []).length };
    },
  });

  // Upcoming ROI by date (active portfolios with a next_roi_date within horizon).
  const { data: roiRows, isLoading: roiLoading } = useQuery({
    queryKey: ['finops-liquidity-roi', fromDateStr, toDateStr],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, portfolio_code, account_name, investor_id, investment_amount, roi_percentage, roi_mode, next_roi_date, auto_reinvest, payment_method, mobile_money_number')
        .eq('status', 'active')
        .not('next_roi_date', 'is', null)
        .gte('next_roi_date', fromDateStr)
        .lte('next_roi_date', toDateStr)
        .order('next_roi_date', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return (data || []).map((r: any) => {
        const gross = Math.round(Number(r.investment_amount || 0) * Number(r.roi_percentage || 0) / 100);
        return { ...r, roi_amount: gross };
      });
    },
  });

  // Agent → Landlord payout float obligations (rent already collected, payout still owed).
  // We use `sla_deadline` as the expected outflow date and include statuses that still
  // represent money the pool must ship out.
  const PENDING_LP_STATUSES = ['pending_merchant_payout', 'awaiting_agent_receipt', 'failed', 'pending', 'queued'];
  const { data: lpRows, isLoading: lpLoading } = useQuery({
    queryKey: ['finops-liquidity-landlord-payouts', fromDateStr, toDateStr],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select('id, landlord_name, landlord_phone, amount, status, sla_deadline, mobile_money_provider, created_at')
        .in('status', PENDING_LP_STATUSES)
        .gte('sla_deadline', new Date(fromDateStr).toISOString())
        .lte('sla_deadline', new Date(new Date(toDateStr).getTime() + 86_400_000).toISOString())
        .order('sla_deadline', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return data || [];
    },
  });

  // Overdue pool of landlord payouts already past SLA — always shown so it can't be hidden by the filter.
  const { data: lpOverdue } = useQuery({
    queryKey: ['finops-liquidity-landlord-payouts-overdue'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select('amount, status')
        .in('status', PENDING_LP_STATUSES)
        .lt('sla_deadline', new Date().toISOString());
      if (error) throw error;
      const total = (data || []).reduce((s, r: any) => s + Number(r.amount || 0), 0);
      return { total, count: (data || []).length };
    },
  });

  const byDate = useMemo(() => {
    const map = new Map<string, { date: string; total: number; cashout: number; reinvest: number; rows: any[] }>();
    (roiRows || []).forEach((r: any) => {
      const d = String(r.next_roi_date);
      if (!map.has(d)) map.set(d, { date: d, total: 0, cashout: 0, reinvest: 0, rows: [] });
      const b = map.get(d)!;
      b.total += r.roi_amount;
      // auto_reinvest OR compounding roi_mode means no cash leaves — group separately.
      const isReinvest = r.auto_reinvest === true || r.roi_mode === 'compounding';
      if (isReinvest) b.reinvest += r.roi_amount;
      else b.cashout += r.roi_amount;
      b.rows.push(r);
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [roiRows]);

  const totals = useMemo(() => {
    return byDate.reduce(
      (acc, b) => ({ total: acc.total + b.total, cashout: acc.cashout + b.cashout, reinvest: acc.reinvest + b.reinvest }),
      { total: 0, cashout: 0, reinvest: 0 },
    );
  }, [byDate]);

  const maxDay = Math.max(1, ...byDate.map((b) => b.total));

  // Landlord payout float grouped by day (using sla_deadline date).
  const lpByDate = useMemo(() => {
    const map = new Map<string, { date: string; total: number; count: number; rows: any[] }>();
    (lpRows || []).forEach((r: any) => {
      const d = String(r.sla_deadline).slice(0, 10);
      if (!map.has(d)) map.set(d, { date: d, total: 0, count: 0, rows: [] });
      const b = map.get(d)!;
      b.total += Number(r.amount || 0);
      b.count += 1;
      b.rows.push(r);
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [lpRows]);
  const lpTotal = useMemo(() => lpByDate.reduce((s, b) => s + b.total, 0), [lpByDate]);
  const lpMaxDay = Math.max(1, ...lpByDate.map((b) => b.total));
  const [lpExpandedDate, setLpExpandedDate] = useState<string | null>(null);

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
            {(lpRows || []).length} payouts due
            {lpOverdue && lpOverdue.count > 0 && (
              <> · <span className="text-red-600 font-semibold">{formatUGX(lpOverdue.total)} overdue</span></>
            )}
          </p>
        </div>
      </div>

      {/* Horizon + calendar date-range filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Horizon</span>
        <div className="flex gap-1">
          {HORIZONS.map((h) => (
            <button
              key={h}
              onClick={() => {
                setHorizon(h);
                setDateRange(undefined);
              }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                !dateRange && horizon === h
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground hover:bg-muted/70',
              )}
            >
              {h}d
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">or</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-8 text-xs font-semibold',
                dateRange && 'border-primary text-primary',
              )}
            >
              <CalendarIcon className="mr-2 h-3.5 w-3.5" />
              {dateRange?.from
                ? dateRange.to
                  ? `${format(dateRange.from, 'MMM d')} → ${format(dateRange.to, 'MMM d')}`
                  : format(dateRange.from, 'MMM d, yyyy')
                : 'Pick date range'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={dateRange}
              onSelect={setDateRange}
              numberOfMonths={2}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
            />
          </PopoverContent>
        </Popover>
        {dateRange && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setDateRange(undefined)}
          >
            <X className="mr-1 h-3 w-3" /> Clear
          </Button>
        )}
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
                          {b.rows.length} portfolio{b.rows.length === 1 ? '' : 's'}
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
              const isOverdue = new Date(b.date) < new Date(new Date().toISOString().slice(0, 10));
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