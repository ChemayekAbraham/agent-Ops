import { lazy, Suspense, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ComposedChart } from 'recharts';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useTppoPortfolioMetrics,
  type TppoPeriodMode,
} from '@/hooks/useTppoPortfolioMetrics';

/** The Agent Ops report itself, reused unchanged for the second tab. */
const PortfolioPerformanceReport = lazy(
  () => import('@/pages/tenant-ops/PortfolioPerformanceReport'),
);

function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftAnchor(anchor: string, mode: TppoPeriodMode, direction: 1 | -1): string {
  const d = toUtc(anchor);
  if (mode === 'month') d.setUTCMonth(d.getUTCMonth() + direction);
  else if (mode === 'week') d.setUTCDate(d.getUTCDate() + 7 * direction);
  else d.setUTCDate(d.getUTCDate() + direction);
  return isoOf(d);
}

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : formatUGX(v);

const signedMoney = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${formatUGX(Math.abs(v))}`;
};

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(1)}%`;

const signedPct = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(1)}%`;
};

interface KpiProps {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'bad';
}

function Kpi({ label, value, hint, tone = 'default' }: KpiProps) {
  const valueTone =
    tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-destructive' : 'text-foreground';
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-1 p-3 sm:p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className={`break-words font-mono text-base font-bold tabular-nums sm:text-lg ${valueTone}`}>
          {value}
        </p>
        {hint && <p className="mt-auto text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Tenant Ops → Workspaces copy of Portfolio Performance.
 *
 * Every figure comes from the RPCs the Agent Ops page already uses
 * (`tppo_get_report_zone_a`, `tppo_arrears_movement`, `tppo_period_plan_detail`).
 * Nothing is written and no collection, arrears or rate logic is reimplemented.
 */
export function TenantOpsPortfolioPerformance() {
  const today = kampalaToday();
  const [mode, setMode] = useState<TppoPeriodMode>('day');
  const [anchor, setAnchor] = useState<string>(today);
  const [rangeStart, setRangeStart] = useState<string>(() => {
    const d = toUtc(today);
    d.setUTCDate(d.getUTCDate() - 6);
    return isoOf(d);
  });
  const [rangeEnd, setRangeEnd] = useState<string>(today);
  const [agent, setAgent] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const {
    isLoading,
    error,
    cells,
    metrics,
    periodLabel,
    stillCounting,
    planDetail,
    planDetailLoading,
    rangeTruncated,
    maxRangeDays,
  } = useTppoPortfolioMetrics({ mode, anchor, rangeStart, rangeEnd });

  const agents = useMemo(() => {
    const names = new Set<string>();
    (planDetail?.rows ?? []).forEach((r) => {
      if (r.agent_name) names.add(r.agent_name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [planDetail]);

  const agentRows = useMemo(() => {
    const rows = planDetail?.rows ?? [];
    const byAgent = new Map<
      string,
      { agent: string; plans: number; scheduled: number; paid: number; arrears: number }
    >();
    rows.forEach((r) => {
      const key = r.agent_name || 'Unassigned';
      const cur =
        byAgent.get(key) ?? { agent: key, plans: 0, scheduled: 0, paid: 0, arrears: 0 };
      cur.plans += 1;
      cur.scheduled += Number(r.scheduled_in_period ?? 0);
      cur.paid += Number(r.paid_in_period ?? 0);
      cur.arrears += Number(r.arrears ?? 0);
      byAgent.set(key, cur);
    });
    const term = search.trim().toLowerCase();
    return Array.from(byAgent.values())
      .filter((r) => (agent === 'all' ? true : r.agent === agent))
      .filter((r) => (term ? r.agent.toLowerCase().includes(term) : true))
      .sort((a, b) => b.scheduled - a.scheduled);
  }, [planDetail, agent, search]);

  const chartData = useMemo(
    () =>
      cells.map((c) => ({
        name: c.label,
        Collected: c.collectedTotal ?? 0,
        'Added to arrears': c.accrued ?? 0,
        'Arrears collected': c.clearedByPayment ?? 0,
        'Closing arrears': c.closingArrears ?? 0,
      })),
    [cells],
  );

  const modeLabel =
    mode === 'range'
      ? `${rangeStart} to ${rangeEnd}`
      : mode === 'day'
        ? 'Day'
        : mode === 'week'
          ? 'Week'
          : 'Month';

  const metricRows: Array<[string, string]> = [
    ['Expected collection', money(metrics.expectedCollection)],
    ['Total amount collected', money(metrics.totalCollected)],
    ['Collected from scheduled', money(metrics.collectedFromScheduled)],
    ['Collected in arrears', money(metrics.collectedInArrears)],
    ['Amount added in arrears', money(metrics.addedInArrears)],
    ['Difference in arrears (added − collected)', signedMoney(metrics.differenceInArrears)],
    ['Closing arrears (previous period)', money(metrics.closingArrearsPrevious)],
    ['New closing arrears total', money(metrics.newClosingArrears)],
    ['Collection rate on scheduled', pct(metrics.scheduledRatePct)],
    ['Collection rate on expected', pct(metrics.expectedRatePct)],
    ['Arrears recovery rate', pct(metrics.arrearsRecoveryRatePct)],
    ['Arrears change on previous period', signedPct(metrics.arrearsChangePct)],
  ];

  const downloadPdf = async () => {
    setExporting(true);
    try {
      const { default: jsPDF } = await import('jspdf');
      const autoTableMod: Record<string, unknown> = await import('jspdf-autotable');
      const autoTable = ((autoTableMod as { default?: unknown }).default ??
        autoTableMod) as (doc: unknown, opts: unknown) => void;

      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const margin = 12;
      doc.setFontSize(14);
      doc.setTextColor(108, 33, 196);
      doc.text('Portfolio Performance — Tenant Ops', margin, 16);
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(`${modeLabel} · ${periodLabel} · Africa/Kampala`, margin, 21);
      if (agent !== 'all') doc.text(`Agent filter: ${agent}`, margin, 26);

      autoTable(doc, {
        startY: agent !== 'all' ? 31 : 26,
        margin: { left: margin, right: margin },
        head: [['Measure', 'Value']],
        body: metricRows,
        styles: { fontSize: 9, cellPadding: 1.8 },
        headStyles: { fillColor: [108, 33, 196], textColor: 255 },
        columnStyles: { 1: { halign: 'right', font: 'courier' } },
      });

      const afterFirst =
        ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 80) + 10;
      doc.setFontSize(11);
      doc.setTextColor(30, 41, 59);
      doc.text('Period breakdown', margin, afterFirst);
      autoTable(doc, {
        startY: afterFirst + 4,
        margin: { left: margin, right: margin },
        head: [['Period', 'Opening', 'Added', 'Collected in arrears', 'Closing', 'Collected']],
        body: cells.map((c) => [
          c.label + (c.stillCounting ? ' (open)' : ''),
          money(c.openingArrears),
          money(c.accrued),
          money(c.clearedByPayment),
          money(c.closingArrears),
          money(c.collectedTotal),
        ]),
        styles: { fontSize: 8, cellPadding: 1.4, font: 'courier' },
        headStyles: { fillColor: [71, 85, 105], textColor: 255, font: 'helvetica' },
      });

      if (agentRows.length > 0) {
        const afterSecond =
          ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 140) + 10;
        doc.setFontSize(11);
        doc.setTextColor(30, 41, 59);
        doc.text('By agent (plans in this period)', margin, afterSecond);
        autoTable(doc, {
          startY: afterSecond + 4,
          margin: { left: margin, right: margin },
          head: [['Agent', 'Plans', 'Scheduled', 'Collected', 'Arrears']],
          body: agentRows.map((r) => [
            r.agent,
            String(r.plans),
            money(r.scheduled),
            money(r.paid),
            money(r.arrears),
          ]),
          styles: { fontSize: 8, cellPadding: 1.4, font: 'courier' },
          headStyles: { fillColor: [71, 85, 105], textColor: 255, font: 'helvetica' },
        });
      }

      doc.save(
        `Welile_Portfolio_Performance_${mode === 'range' ? `${rangeStart}_to_${rangeEnd}` : `${mode}_${anchor}`}.pdf`,
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <Tabs defaultValue="metrics" className="w-full space-y-3">
      <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-grid">
        <TabsTrigger value="metrics">Collections &amp; arrears</TabsTrigger>
        <TabsTrigger value="report">Full report</TabsTrigger>
      </TabsList>

      <TabsContent value="metrics" className="space-y-3">
        <section className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 text-primary">
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
                <span className="text-[11px] font-semibold uppercase tracking-wider">
                  Portfolio performance
                </span>
              </div>
              <span className="text-xs text-muted-foreground">{periodLabel}</span>
              {stillCounting && <Badge variant="outline">still counting</Badge>}
            </div>

            <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid grid-cols-4 gap-1 rounded-lg border p-1 sm:inline-flex">
                  {(['day', 'week', 'month', 'range'] as TppoPeriodMode[]).map((m) => (
                    <Button
                      key={m}
                      type="button"
                      size="sm"
                      variant={mode === m ? 'default' : 'ghost'}
                      onClick={() => setMode(m)}
                      className="min-h-9 px-2 text-xs capitalize sm:px-3"
                    >
                      {m === 'range' ? 'Custom' : m}
                    </Button>
                  ))}
                </div>

                {mode !== 'range' ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Previous period"
                      onClick={() => setAnchor(shiftAnchor(anchor, mode, -1))}
                      className="h-9 w-9"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Input
                      type="date"
                      value={anchor}
                      max={today}
                      onChange={(e) => e.target.value && setAnchor(e.target.value)}
                      aria-label="Anchor date"
                      className="h-9 w-[10.5rem]"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Next period"
                      disabled={shiftAnchor(anchor, mode, 1) > today}
                      onClick={() => setAnchor(shiftAnchor(anchor, mode, 1))}
                      className="h-9 w-9"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={anchor === today}
                      onClick={() => setAnchor(today)}
                      className="h-9"
                    >
                      Today
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="date"
                      value={rangeStart}
                      max={rangeEnd}
                      onChange={(e) => e.target.value && setRangeStart(e.target.value)}
                      aria-label="Range start"
                      className="h-9 w-[10.5rem]"
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input
                      type="date"
                      value={rangeEnd}
                      max={today}
                      min={rangeStart}
                      onChange={(e) => e.target.value && setRangeEnd(e.target.value)}
                      aria-label="Range end"
                      className="h-9 w-[10.5rem]"
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <Select value={agent} onValueChange={setAgent}>
                  <SelectTrigger className="h-9 w-full sm:w-56" aria-label="Filter by agent">
                    <SelectValue placeholder="All agents" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="all">All agents</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative w-full sm:w-52">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search agents"
                    aria-label="Search agents"
                    className="h-9 pl-8"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void downloadPdf()}
                  disabled={isLoading || exporting}
                  className="h-9 gap-1.5"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {exporting ? 'Preparing…' : 'PDF'}
                </Button>
              </div>
            </div>

            {rangeTruncated && (
              <p className="text-[11px] text-muted-foreground">
                A custom range covers at most {maxRangeDays} days; only the first {maxRangeDays} days
                of this range are shown.
              </p>
            )}
          </div>
        </section>

        {error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : isLoading ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                label="Expected collection"
                value={money(metrics.expectedCollection)}
                hint={`${money(metrics.scheduledDue)} scheduled + ${money(metrics.arrearsBroughtForward)} arrears brought forward`}
              />
              <Kpi
                label="Total amount collected"
                value={money(metrics.totalCollected)}
                hint={`${pct(metrics.expectedRatePct)} of expected`}
                tone="good"
              />
              <Kpi
                label="Collected from scheduled"
                value={money(metrics.collectedFromScheduled)}
                hint={`${pct(metrics.scheduledRatePct)} of scheduled due`}
              />
              <Kpi
                label="Collected in arrears"
                value={money(metrics.collectedInArrears)}
                hint={`${pct(metrics.arrearsRecoveryRatePct)} of arrears brought forward`}
                tone="good"
              />
              <Kpi
                label="Amount added in arrears"
                value={money(metrics.addedInArrears)}
                hint="Instalments that fell due and were not paid"
                tone="bad"
              />
              <Kpi
                label="Difference in arrears"
                value={signedMoney(metrics.differenceInArrears)}
                hint="Added in arrears − collected in arrears"
                tone={
                  metrics.differenceInArrears === null
                    ? 'default'
                    : metrics.differenceInArrears > 0
                      ? 'bad'
                      : 'good'
                }
              />
              <Kpi
                label="Closing arrears (previous)"
                value={money(metrics.closingArrearsPrevious)}
                hint="Owed when this period opened"
              />
              <Kpi
                label="New closing arrears total"
                value={money(metrics.newClosingArrears)}
                hint={`${signedPct(metrics.arrearsChangePct)} on the previous period`}
                tone={
                  metrics.arrearsChangePct === null
                    ? 'default'
                    : metrics.arrearsChangePct > 0
                      ? 'bad'
                      : 'good'
                }
              />
            </div>

            <section className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Collections against arrears movement
              </p>
              <div className="h-64 w-full sm:h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      width={64}
                      tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                    />
                    <Tooltip formatter={(v: number) => formatUGX(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Collected" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Added to arrears" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Arrears collected" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} />
                    <Line
                      type="monotone"
                      dataKey="Closing arrears"
                      stroke="hsl(var(--foreground))"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Period breakdown
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 text-left font-medium">Period</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Opening</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Added</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Arrears collected</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Closing</th>
                      <th scope="col" className="py-2 text-right font-medium">Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cells.map((c) => (
                      <tr key={c.key} className="border-b border-border/60">
                        <td className="py-2 pr-3">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">{c.label}</span>
                            {c.stillCounting && (
                              <Badge variant="outline" className="text-[10px]">still counting</Badge>
                            )}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{money(c.openingArrears)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-destructive">{money(c.accrued)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-emerald-600">{money(c.clearedByPayment)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{money(c.closingArrears)}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{money(c.collectedTotal)}</td>
                      </tr>
                    ))}
                    {cells.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                          No reporting periods for this selection.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                By agent
              </p>
              <p className="mb-3 text-[11px] text-muted-foreground">
                Plans in {mode === 'range' ? `the day ending ${rangeEnd}` : `this ${mode}`}, as reported by
                the shared plan-detail source. Portfolio arrears above are period-wide and are not split
                by agent.
              </p>
              {planDetailLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="py-2 pr-3 text-left font-medium">Agent</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Plans</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Scheduled</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Collected</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Arrears</th>
                        <th scope="col" className="py-2 text-right font-medium">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentRows.map((r) => (
                        <tr key={r.agent} className="border-b border-border/60">
                          <td className="py-2 pr-3 text-foreground">{r.agent}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums">{r.plans}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums">{money(r.scheduled)}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums">{money(r.paid)}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums text-destructive">{money(r.arrears)}</td>
                          <td className="py-2 text-right font-mono tabular-nums">
                            {r.scheduled > 0 ? pct((r.paid / r.scheduled) * 100) : '—'}
                          </td>
                        </tr>
                      ))}
                      {agentRows.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                            No plans match this filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </TabsContent>

      <TabsContent value="report">
        <Suspense
          fallback={
            <div className="flex min-h-64 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          }
        >
          <PortfolioPerformanceReport />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}

export default TenantOpsPortfolioPerformance;
