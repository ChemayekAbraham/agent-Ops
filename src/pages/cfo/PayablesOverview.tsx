import { useState, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, LayoutGrid, Search, RefreshCw, ChevronRight, TrendingDown,
  Wallet, Users, CalendarDays, AlertTriangle, CheckCircle2, Handshake,
  Building2, Package, Layers, Clock, ShieldCheck, ArrowUpRight, BarChart3,
  Check, Info
} from 'lucide-react';
import {
  ResponsiveContainer, Tooltip, ComposedChart,
  CartesianGrid, XAxis, YAxis, Bar, Line
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  usePayablesTotal, usePayablesBreakdown, usePayablesPredictiveForecast,
  usePayablesContractSchedule, type PayableProduct, type PayableItem
} from '@/hooks/usePayables';
import { formatUGX } from '@/lib/rentCalculations';
import { PartnerPaidOutstandingPanel } from '@/components/cfo/PartnerPaidOutstandingPanel';

const ICONS = [Handshake, Building2, Wallet, Users, Layers, Package];

const money = (value: number | null | undefined) => (value == null ? 'Unavailable' : formatUGX(value));

const compact = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return value.toFixed(0);
};

const pct = (value: number, total: number) => (total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0.0%');

/**
 * CFO Payables Command Center
 * Clean, executive-grade workspace for obligations, liquidity, and settlement schedules.
 */
export default function PayablesOverview() {
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const catKey = params.get('cat') ?? 'overview';

  const total = usePayablesTotal(true);
  const breakdown = usePayablesBreakdown(true, true);
  const forecast = usePayablesPredictiveForecast('day', 7, catKey === 'overview');

  const cats = breakdown.data?.categories ?? total.data?.categories?.map((c) => ({
    key: c.key,
    label: c.label,
    outstanding: c.outstanding,
    item_count: c.item_count,
    products: [] as PayableProduct[],
  })) ?? [];
  const cat = cats.find((c) => c.key === catKey);
  const product = cat?.products.find((p) => p.key === params.get('sub')) ?? cat?.products[0];

  const rawError = total.error || breakdown.error;
  const syncErrorMsg = rawError instanceof Error ? rawError.message : typeof rawError === 'object' && rawError && 'message' in rawError ? String((rawError as any).message) : '';
  const isAuthError = syncErrorMsg.includes('Not authorised') || syncErrorMsg.includes('42501') || syncErrorMsg.includes('JWT');

  const go = (key: string, sub?: string) => {
    const next = new URLSearchParams();
    if (key !== 'overview') next.set('cat', key);
    if (sub) next.set('sub', sub);
    setParams(next, { replace: true });
  };

  const validation = breakdown.data?.validation;
  const periods = forecast.data?.periods;
  const expected = periods?.reduce((sum, p) => sum + p.forecast_amount, 0);
  const scheduled = periods?.reduce((sum, p) => sum + p.scheduled_amount, 0);
  const chart = periods?.map((p) => ({
    label: p.label,
    amount: p.forecast_amount,
    scheduled: p.scheduled_amount,
  })) ?? [];

  const allItems = cats.flatMap((c) => c.products.flatMap((p) => p.items));
  const complete = !!breakdown.data && cats.every((c) => c.products.every((p) => p.items.length === p.item_count));
  const items = [...allItems].sort((a, b) => b.amount - a.amount).slice(0, 8);

  const refreshing = total.isFetching || breakdown.isFetching || forecast.isFetching;
  const refresh = () => {
    void total.refetch();
    void breakdown.refetch();
    if (catKey === 'overview') void forecast.refetch();
  };

  const totalPayables = total.data?.total ?? 0;
  const overduePayables = total.data?.overdue ?? 0;
  const currentPayables = forecast.data?.actual?.not_yet_due ?? (totalPayables > overduePayables ? totalPayables - overduePayables : 0);
  const dueToday = total.data?.due_today ?? 0;
  const openAccounts = total.data?.item_count ?? 0;

  const filteredCats = useMemo(() => {
    if (!search.trim()) return cats;
    const term = search.toLowerCase();
    return cats.filter((c) => c.label.toLowerCase().includes(term));
  }, [cats, search]);

  return (
    <main className="receivables-workspace min-h-screen bg-background text-foreground">
      {/* Top Header Bar */}
      <div className="border-b border-border bg-card lg:fixed lg:inset-x-0 lg:top-0 lg:z-30 flex h-14 items-center px-4">
        <Link
          to="/cfo/dashboard"
          className="hidden h-full w-[210px] shrink-0 items-center gap-2 border-r border-border pr-4 text-sm font-semibold tracking-tight text-foreground hover:text-primary transition-colors lg:flex"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <TrendingDown className="h-4 w-4" />
          </div>
          <span>Welile CFO</span>
        </Link>

        <div className="relative mx-4 w-full max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search payable categories"
            placeholder="Search categories or obligations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 rounded-md bg-muted/40 border-border/60 pl-9 text-xs focus-visible:bg-background"
          />
        </div>

        <div className="ml-auto flex items-center gap-3">
          {validation && (
            <div
              className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                validation.ties_out
                  ? 'bg-success/10 text-success'
                  : 'bg-destructive/10 text-destructive'
              }`}
            >
              {validation.ties_out ? (
                <>
                  <Check className="h-3 w-3" />
                  <span>Ledger Balanced</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3" />
                  <span>Variance: {formatUGX(validation.difference)}</span>
                </>
              )}
            </div>
          )}
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-muted text-muted-foreground">CFO</span>
        </div>
      </div>

      {/* Main Grid: Sidebar + Workspace */}
      <div className="lg:pt-14 grid grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)]">
        {/* Left Category Sidebar */}
        <nav
          aria-label="Payable categories"
          className="border-r border-border bg-card px-3 py-4 flex flex-col lg:fixed lg:bottom-0 lg:left-0 lg:top-14 lg:w-[210px] lg:overflow-y-auto"
        >
          <Button asChild variant="ghost" className="mb-3 h-8 justify-start px-2 text-xs text-muted-foreground hover:text-foreground">
            <Link to="/cfo/dashboard">
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
              CFO Dashboard
            </Link>
          </Button>

          <div className="space-y-0.5">
            <SideItem
              active={catKey === 'overview'}
              icon={LayoutGrid}
              label="Overview"
              count={cats.length ? openAccounts : undefined}
              onClick={() => go('overview')}
            />

            <div className="pt-3 pb-1.5">
              <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Categories</p>
            </div>

            {cats.map((c, i) => (
              <SideItem
                key={c.key}
                active={catKey === c.key}
                icon={ICONS[i % ICONS.length]}
                label={c.label}
                count={c.item_count}
                onClick={() => go(c.key)}
              />
            ))}

            <div className="my-3 border-t border-border" />

            <SideItem
              active={catKey === 'daily'}
              icon={BarChart3}
              label="Cash Forecast"
              onClick={() => go('daily')}
            />
          </div>
        </nav>

        {/* Center Workspace Content */}
        <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:col-start-2">
          {/* Breadcrumb Navigation */}
          {cat && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Button variant="link" className="h-auto min-h-0 p-0 text-xs text-primary" onClick={() => go('overview')}>
                Payables
              </Button>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium text-foreground">{cat.label}</span>
              {product && cat.key !== 'partner' && (
                <>
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">{product.label}</span>
                </>
              )}
            </div>
          )}

          {/* Page Header */}
          <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                {cat?.label ?? (catKey === 'daily' ? 'Payables Outflow Forecast' : 'Payables Overview')}
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {catKey === 'daily'
                  ? 'Predictive and contractual cash requirements across obligation horizons.'
                  : cat
                  ? `Obligations and settlement schedule for ${cat.label}.`
                  : 'Outstanding obligations, payment schedules and expected payouts.'}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Last updated · <span className="font-medium text-foreground">{breakdown.data?.as_at?.slice(0, 10) ?? 'Live'}</span> · EAT
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-md text-xs font-medium text-foreground hover:bg-muted"
                disabled={refreshing}
                onClick={refresh}
              >
                <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
                <span>Refresh</span>
              </Button>
            </div>
          </header>

          <div className="flex flex-col gap-6 min-w-0">
            {/* ROUTE CONTENT: DAILY FORECAST */}
            {catKey === 'daily' ? (
              <DailyForecast />
            ) : catKey !== 'overview' && breakdown.isLoading ? (
              <Panel>
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin text-primary" />
                  Loading live payables breakdown…
                </div>
              </Panel>
            ) : catKey !== 'overview' && (breakdown.isError || total.isError) ? (
              <Panel>
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <AlertTriangle className="h-6 w-6 text-destructive mb-2" />
                  <p className="text-sm font-semibold text-destructive">Could not load payable records</p>
                  <p className="text-xs text-muted-foreground mt-1">Please check network connectivity or refresh.</p>
                  <Button variant="outline" size="sm" onClick={refresh} className="mt-3">Try Again</Button>
                </div>
              </Panel>
            ) : cat ? (
              <>
                {cat.key === 'partner' && <PartnerPaidOutstandingPanel />}
                {cat.key === 'partner' ? null : cat.products.length ? (
                  <>
                    <div
                      role="tablist"
                      aria-label="Payable products"
                      className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1 shadow-sm"
                    >
                      {cat.products.map((p) => (
                        <Button
                          key={p.key}
                          variant="ghost"
                          size="sm"
                          role="tab"
                          aria-selected={product?.key === p.key}
                          onClick={() => go(cat.key, p.key)}
                          className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                            product?.key === p.key
                              ? 'bg-primary text-primary-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                          }`}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                    {product && <ProductDetail product={product} />}
                  </>
                ) : (
                  <Panel>
                    <p className="text-sm text-muted-foreground py-8 text-center">No open payables in this category.</p>
                  </Panel>
                )}
              </>
            ) : (
              /* MAIN OVERVIEW VIEW */
              <>
                {/* Clean 5-Card Liquidity & Obligation Row */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                  <CleanMetricCard
                    label="Total Payables"
                    value={money(total.data?.total)}
                    note={`${openAccounts.toLocaleString()} open accounts`}
                    tag="Obligations"
                  />
                  <CleanMetricCard
                    label="Current"
                    value={money(currentPayables)}
                    note={`${pct(currentPayables, totalPayables)} not yet due`}
                    tag="Good standing"
                    tone="success"
                  />
                  <CleanMetricCard
                    label="Overdue"
                    value={money(overduePayables)}
                    note={overduePayables > 0 ? "Past contractual due date" : "Zero overdue"}
                    tag={overduePayables > 0 ? "Requires action" : "Clean"}
                    tone={overduePayables > 0 ? "destructive" : "muted"}
                  />
                  <CleanMetricCard
                    label="Due in 7 Days"
                    value={money(scheduled)}
                    note="Scheduled contractual portion"
                    tag="Next 7 Days"
                    tone="info"
                  />
                  <CleanMetricCard
                    label="Due Today"
                    value={money(dueToday)}
                    note="Immediate settlement commitments"
                    tag="Today"
                    tone="warning"
                  />
                </div>

                {breakdown.isLoading && (
                  <p role="status" className="text-xs text-muted-foreground animate-pulse">
                    Synchronizing authoritative ledger details…
                  </p>
                )}
                {(breakdown.isError || total.isError) && (
                  <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                      <span>
                        {isAuthError
                          ? 'Not authorized to view payables. Please sign in with an authorized CFO, CEO, COO, or Financial Ops account.'
                          : `Could not complete payables synchronization${syncErrorMsg ? `: ${syncErrorMsg}` : ''}. Please click Refresh.`}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refresh}
                      disabled={refreshing}
                      className="h-7 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/20 hover:text-destructive shrink-0"
                    >
                      <RefreshCw className={`h-3 w-3 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
                      Refresh
                    </Button>
                  </div>
                )}

                {/* Main 2-Column Section */}
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start [&>*]:min-w-0">
                  {/* Left Column (7 cols): Clean Category Table & Outflow Chart */}
                  <div className="xl:col-span-7 space-y-5">
                    {/* Category Breakdown Table (Clean, no donut chart) */}
                    <Panel
                      title="Payables by Category"
                      subtitle="Outstanding obligations and portfolio share across operating categories"
                    >
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border text-muted-foreground font-medium text-[11px]">
                              <th className="pb-2.5 text-left font-medium">Category</th>
                              <th className="pb-2.5 text-right font-medium">Items</th>
                              <th className="pb-2.5 text-right font-medium">Outstanding (UGX)</th>
                              <th className="pb-2.5 text-right font-medium">Share</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {filteredCats.map((c, i) => {
                              const Icon = ICONS[i % ICONS.length];
                              const shareNum = totalPayables > 0 ? (c.outstanding / totalPayables) * 100 : 0;
                              return (
                                <tr key={c.key} className="hover:bg-muted/30 transition-colors group">
                                  <td className="py-2.5 pr-2">
                                    <Button
                                      variant="ghost"
                                      className="h-auto min-h-0 justify-start p-0 text-xs font-medium text-foreground group-hover:text-primary transition-colors text-left"
                                      onClick={() => go(c.key)}
                                    >
                                      <span className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                                        <Icon className="h-3.5 w-3.5" />
                                      </span>
                                      <span className="truncate">{c.label}</span>
                                      <ChevronRight className="ml-1 h-3 w-3 text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </Button>
                                  </td>
                                  <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                                    {c.item_count.toLocaleString()}
                                  </td>
                                  <td className="py-2.5 px-2 text-right tabular-nums font-semibold text-foreground whitespace-nowrap">
                                    {formatUGX(c.outstanding).replace(/^UGX\s*/, '')}
                                  </td>
                                  <td className="py-2.5 pl-2 text-right">
                                    <div className="flex items-center justify-end gap-2">
                                      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                        <div
                                          className="h-full rounded-full bg-primary"
                                          style={{
                                            width: `${Math.min(100, Math.max(shareNum, 2))}%`,
                                          }}
                                        />
                                      </div>
                                      <span className="tabular-nums font-medium text-muted-foreground w-11 text-right">
                                        {shareNum.toFixed(1)}%
                                      </span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-border font-semibold text-foreground bg-muted/20">
                              <td className="py-2.5 pr-2">Total Payables</td>
                              <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                                {openAccounts.toLocaleString()}
                              </td>
                              <td className="py-2.5 px-2 text-right tabular-nums font-bold">
                                {formatUGX(totalPayables).replace(/^UGX\s*/, '')}
                              </td>
                              <td className="py-2.5 pl-2 text-right tabular-nums">100.0%</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </Panel>

                    {/* 7-Day Cash Outflow Forecast Chart */}
                    <Panel
                      title="7-Day Payables Forecast"
                      subtitle="Daily expected payout demands vs contractual maturities"
                      right={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-primary hover:text-primary hover:bg-primary/10 gap-1 px-2"
                          onClick={() => go('daily')}
                        >
                          <span>Full Forecast</span>
                          <ArrowUpRight className="h-3 w-3" />
                        </Button>
                      }
                    >
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 rounded-sm bg-primary" />
                            <span className="text-muted-foreground">Expected Outflow (est.)</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="h-0.5 w-3 bg-success" />
                            <span className="text-muted-foreground">Scheduled portion</span>
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          7-Day Total: <strong className="text-foreground">{money(expected)}</strong>
                        </div>
                      </div>

                      <div className="h-56 w-full pt-1">
                        {chart.length === 0 ? (
                          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                            No forecast data available
                          </div>
                        ) : (
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={chart} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                              <XAxis
                                dataKey="label"
                                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                                tickLine={false}
                                axisLine={false}
                              />
                              <YAxis
                                tickFormatter={compact}
                                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                                tickLine={false}
                                axisLine={false}
                                width={50}
                              />
                              <Tooltip
                                formatter={(v: number) => formatUGX(v)}
                                contentStyle={{
                                  fontSize: 12,
                                  borderRadius: 6,
                                  background: 'hsl(var(--card))',
                                  border: '1px solid hsl(var(--border))',
                                }}
                              />
                              <Bar
                                dataKey="amount"
                                name="Expected payouts (est.)"
                                fill="hsl(var(--primary))"
                                maxBarSize={28}
                                radius={[3, 3, 0, 0]}
                              />
                              <Line
                                dataKey="scheduled"
                                name="Scheduled portion"
                                stroke="hsl(var(--success))"
                                strokeWidth={2}
                                dot={{ r: 2.5, fill: 'hsl(var(--success))' }}
                              />
                            </ComposedChart>
                          </ResponsiveContainer>
                        )}
                      </div>

                      {forecast.isError && (
                        <p className="mt-2 text-xs text-destructive flex items-center gap-1">
                          <AlertTriangle className="h-3.5 w-3.5" /> Forecast unavailable. Please refresh.
                        </p>
                      )}
                      {periods?.some((p) => p.quality === 'low' || p.quality === 'insufficient') && (
                        <p className="mt-2 text-[11px] text-muted-foreground flex items-center gap-1">
                          <Info className="h-3 w-3" /> Limited history; estimates include low-confidence intervals.
                        </p>
                      )}
                    </Panel>
                  </div>

                  {/* Right Column (5 cols): 7-Day Settlement Outlook & Top Counterparties */}
                  <div className="xl:col-span-5 space-y-5">
                    {/* Payment Outlook (Next 7 Days) */}
                    <Panel
                      title="Payment Outlook (Next 7 Days)"
                      subtitle="Cash demands broken down by commitment certainty"
                    >
                      <div className="space-y-2.5">
                        <OutlookRow
                          label="Expected Payouts (est.)"
                          sub="Estimated cash outflow for next 7 days"
                          value={money(expected)}
                          highlight
                        />
                        <OutlookRow
                          label="Scheduled Portion"
                          sub="Contractual maturities scheduled"
                          value={money(scheduled)}
                        />
                        <OutlookRow
                          label="Unscheduled Obligations"
                          sub="Recorded liabilities without fixed maturity"
                          value={money(forecast.data?.unscheduled?.amount)}
                        />

                        {forecast.data?.unscheduled && (
                          <p className="text-[11px] text-muted-foreground pt-1">
                            Included in total payables; excluded from the dated forecast.
                          </p>
                        )}
                      </div>
                    </Panel>

                    {/* Top Outstanding Obligations */}
                    <Panel
                      title="Top Outstanding Obligations"
                      subtitle={complete ? 'Largest obligations in live portfolio' : 'Largest items in the available account sample'}
                    >
                      <ItemTable items={items} />
                    </Panel>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents & UI Blocks
// ─────────────────────────────────────────────────────────────────────────────

function CleanMetricCard({
  label,
  value,
  note,
  tag,
  tone = 'primary',
}: {
  label: string;
  value: string;
  note: string;
  tag: string;
  tone?: 'primary' | 'success' | 'destructive' | 'warning' | 'info' | 'muted';
}) {
  const tones = {
    primary: 'text-primary',
    success: 'text-success',
    destructive: 'text-destructive',
    warning: 'text-warning',
    info: 'text-primary',
    muted: 'text-muted-foreground',
  };

  const tagTones = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    destructive: 'bg-destructive/10 text-destructive',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-primary/10 text-primary',
    muted: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm hover:border-border/80 transition-colors">
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${tagTones[tone]}`}>
          {tag}
        </span>
      </div>
      <div className="mt-2">
        <div className="text-lg font-bold tracking-tight text-foreground tabular-nums truncate" title={value}>
          {value}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground truncate">{note}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  right,
  children,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {(title || right) && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>}
            {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function SideItem({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: typeof Users;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`w-full h-8 justify-start gap-2 rounded-lg px-2 text-left transition-colors ${
        active
          ? 'bg-primary/10 text-primary font-semibold'
          : 'text-foreground hover:bg-muted font-normal'
      }`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      {count !== undefined && (
        <span
          className={`ml-auto text-[10px] font-medium tabular-nums px-1.5 py-0.2 rounded-full ${
            active ? 'bg-primary/20 text-primary font-semibold' : 'bg-muted text-muted-foreground'
          }`}
        >
          {count.toLocaleString()}
        </span>
      )}
    </Button>
  );
}

function OutlookRow({
  label,
  sub,
  value,
  highlight = false,
}: {
  label: string;
  sub: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 p-3 rounded-lg border transition-colors ${
        highlight
          ? 'border-primary/30 bg-primary/5 text-foreground'
          : 'border-border/60 bg-muted/20 text-foreground'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className={`text-xs font-semibold ${highlight ? 'text-primary' : 'text-foreground'}`}>
          {label}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">{sub}</div>
      </div>
      <div className="text-sm font-bold tabular-nums text-foreground whitespace-nowrap">
        {value}
      </div>
    </div>
  );
}

function ItemTable({ items }: { items: PayableItem[] }) {
  if (!items.length) {
    return <p className="py-6 text-center text-xs text-muted-foreground">No recorded payable accounts.</p>;
  }

  return (
    <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground sticky top-0 z-10 font-medium text-[11px]">
          <tr>
            <th className="py-2 px-2.5 text-left font-medium">Account / Counterparty</th>
            <th className="py-2 px-2.5 text-left font-medium">Due Date</th>
            <th className="py-2 px-2.5 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {items.map((item) => (
            <tr key={`${item.source}:${item.item_id}`} className="hover:bg-muted/30 transition-colors">
              <td className="py-2.5 px-2.5">
                <div className="font-medium text-foreground truncate max-w-[200px]" title={item.counterparty}>
                  {item.counterparty || 'Unnamed'}
                </div>
                {item.status && (
                  <span className="text-[10px] text-muted-foreground capitalize">
                    {item.status.replace(/_/g, ' ')}
                  </span>
                )}
              </td>
              <td className="py-2.5 px-2.5 text-muted-foreground whitespace-nowrap font-mono text-[11px]">
                {item.due_date ? `${item.due_kind === 'projected' ? 'Est. ' : ''}${item.due_date.slice(0, 10)}` : 'No date'}
              </td>
              <td className="py-2.5 px-2.5 text-right tabular-nums font-semibold text-foreground whitespace-nowrap">
                {formatUGX(item.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductDetail({ product }: { product: PayableProduct }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <CleanMetricCard
          label="Outstanding"
          value={formatUGX(product.outstanding)}
          note="Recorded liabilities"
          tag="Product"
        />
        <CleanMetricCard
          label="Accounts"
          value={product.item_count.toLocaleString()}
          note="Open obligations"
          tag="Items"
          tone="info"
        />
        <CleanMetricCard
          label="Scheduled"
          value={formatUGX(product.scheduled_amount)}
          note="Scheduled payable amount"
          tag="Scheduled"
          tone="success"
        />
        <CleanMetricCard
          label="Projected"
          value={formatUGX(product.projected_amount)}
          note="Projected payable amount"
          tag="Projected"
          tone="warning"
        />
        <CleanMetricCard
          label="Payment Source"
          value={product.source.replace(/_/g, ' ')}
          note="Recorded source"
          tag="Source"
          tone="muted"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        <div className="xl:col-span-7">
          <Panel
            title={`Top Accounts — ${product.label}`}
            subtitle={
              product.items.length < product.item_count
                ? `Showing largest ${product.items.length} of ${product.item_count} items.`
                : 'Complete account schedule.'
            }
          >
            <ItemTable items={product.items} />
          </Panel>
        </div>

        <div className="xl:col-span-5 space-y-5">
          <Panel title="Schedule Composition" subtitle="Contractual scheduled vs projected split">
            <div className="space-y-2.5 pt-1">
              <OutlookRow label="Contractual Scheduled" sub="Fixed commitments" value={formatUGX(product.scheduled_amount)} />
              <OutlookRow label="Behavioral Projected" sub="Statistical projections" value={formatUGX(product.projected_amount)} />
              <OutlookRow label="Total Outstanding" sub="Active liability" value={formatUGX(product.outstanding)} highlight />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

const FORECAST_PERIODS = [
  { id: '7d', label: 'Next 7 days', gran: 'day' as const, n: 7 },
  { id: '14d', label: 'Next 14 days', gran: 'day' as const, n: 14 },
  { id: '30d', label: 'Next 30 days', gran: 'day' as const, n: 30 },
  { id: '60d', label: 'Next 60 days', gran: 'day' as const, n: 60 },
  { id: '90d', label: 'Next 90 days', gran: 'day' as const, n: 90 },
  { id: '1y', label: 'Next 1 year', gran: 'month' as const, n: 12 },
  { id: '2y', label: 'Next 2 years', gran: 'month' as const, n: 24 },
  { id: '3y', label: 'Next 3 years', gran: 'month' as const, n: 36 },
];

function DailyForecast() {
  const [pid, setPid] = useState('7d');
  const period = FORECAST_PERIODS.find((p) => p.id === pid) ?? FORECAST_PERIODS[0];
  const daily = period.gran === 'day';

  const q = usePayablesPredictiveForecast(period.gran, period.n);
  const contractQ = usePayablesContractSchedule(period.gran, period.n, true, true);

  const history = q.data?.history ?? [];
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const overall = avg(history.map((x) => x.actual_amount));
  const contractMap = new Map((contractQ.data ?? []).map((c) => [c.index, Number(c.contract_amount ?? 0)]));

  const rows = (q.data?.periods ?? []).map((p) => {
    const dow = new Date(p.period_start).getUTCDay();
    const same = daily ? history.filter((x) => new Date(x.period_start).getUTCDay() === dow).map((x) => x.actual_amount) : [];
    return {
      key: p.period_start,
      date: daily ? p.period_start.slice(0, 10) : p.label,
      label: p.label,
      behavior: Math.round(same.length ? avg(same) : overall),
      contract: contractMap.get(p.index) ?? 0,
    };
  });

  const sum = rows.reduce((a, r) => a + r.behavior, 0);
  const sched = rows.reduce((a, r) => a + r.contract, 0);
  const unit = daily ? 'day' : 'month';

  return (
    <div className="space-y-5">
      {/* Period Selection Tabs */}
      <div
        role="tablist"
        aria-label="Forecast period"
        className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1 shadow-sm"
      >
        {FORECAST_PERIODS.map((p) => (
          <Button
            key={p.id}
            variant="ghost"
            size="sm"
            role="tab"
            aria-selected={pid === p.id}
            onClick={() => setPid(p.id)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
              pid === p.id
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {q.isLoading || contractQ.isLoading ? (
        <Panel>
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 mr-2 animate-spin text-primary" />
            Computing predictive outflow curves…
          </div>
        </Panel>
      ) : q.isError ? (
        <Panel>
          <p className="text-xs text-destructive py-6 text-center">Forecast model unavailable. Please refresh.</p>
        </Panel>
      ) : (
        <>
          {/* 3 Executive Forecast Metric Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <CleanMetricCard
              label="Behavioral Projection"
              value={formatUGX(sum)}
              note={`Demand for ${period.label}`}
              tag="Estimate"
              tone="primary"
            />
            <CleanMetricCard
              label="Contractual Scheduled"
              value={contractQ.isError ? 'Unavailable' : formatUGX(sched)}
              note="Scheduled by contract"
              tag="Contractual"
              tone="success"
            />
            <CleanMetricCard
              label={daily ? 'Daily Average Demand' : 'Monthly Average Demand'}
              value={formatUGX(rows.length ? sum / rows.length : 0)}
              note={`Average per ${unit}`}
              tag="Run-rate"
              tone="warning"
            />
          </div>

          {/* Outflow Curves Chart */}
          <Panel
            title={`Outflow Projection — ${period.label}`}
            subtitle="Statistical behavioral curves vs contractual settlement commitments"
          >
            <div className="h-64 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={55} />
                  <Tooltip
                    formatter={(v: number) => formatUGX(v)}
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 6,
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                    }}
                  />
                  <Bar
                    dataKey="behavior"
                    name="Behavioral Outflow"
                    fill="hsl(var(--primary))"
                    maxBarSize={24}
                    radius={[3, 3, 0, 0]}
                  />
                  <Line
                    dataKey="contract"
                    name="Contractual Scheduled"
                    stroke="hsl(var(--success))"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: 'hsl(var(--success))' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          {/* Day by Day Table */}
          <Panel
            title={daily ? 'Day-by-Day Cash Demand Schedule' : 'Month-by-Month Schedule'}
            subtitle="Scheduled settlement amounts vs behavioral estimates"
          >
            <div className="overflow-x-auto max-h-[380px]">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground sticky top-0 z-10 font-medium text-[11px]">
                  <tr>
                    <th className="py-2 px-3 text-left font-medium">{daily ? 'Date' : 'Month'}</th>
                    <th className="py-2 px-3 text-right font-medium">Behavioral Projection (UGX)</th>
                    <th className="py-2 px-3 text-right font-medium">Contractual Scheduled (UGX)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rows.map((r) => (
                    <tr key={r.key} className="hover:bg-muted/30 transition-colors">
                      <td className="py-2 px-3 font-mono text-[11px] text-foreground">{r.date}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-foreground font-medium">
                        {formatUGX(r.behavior)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-success font-medium">
                        {formatUGX(r.contract)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-bold bg-muted/20">
                    <td className="py-2 px-3 text-foreground">Total Period Commitment</td>
                    <td className="py-2 px-3 text-right tabular-nums text-foreground font-bold">{formatUGX(sum)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-success font-bold">{formatUGX(sched)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}