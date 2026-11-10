import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Download, RefreshCw, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  type CfoWeeklyReport, type WeeklyAccountLine, prettyCategory, pctChange, deriveRisksAndActions, weekOptions,
} from '@/lib/cfoWeeklyReport';
import { generateCfoWeeklyReportPdf } from '@/lib/cfoWeeklyReportPdf';

const fmt = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))}`;
const fmtShort = (n: number) => {
  const v = Math.abs(n);
  if (v >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
};
/** Calendar date (YYYY-MM-DD) without a time-zone shift. */
const dateOnly = (d: string) => (d ? format(new Date(`${d}T12:00:00`), 'EEE dd MMM yyyy') : '—');
const marginText = (m: number, revenue: number) => (revenue > 0 && Math.abs(m) < 1000 ? `${m}%` : 'n/m');

function Delta({ current, previous }: { current: number; previous: number }) {
  const p = pctChange(current, previous);
  if (p === null) return <span className="text-[11px] text-muted-foreground">no comparative</span>;
  const up = p >= 0;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${up ? 'text-emerald-600' : 'text-destructive'}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? '+' : ''}{p.toFixed(1)}% vs last week
    </span>
  );
}

function Metric({ label, value, caption, tone }: { label: string; value: string; caption?: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums truncate ${tone || ''}`}>{value}</p>
      {caption ? <div className="text-[11px] text-muted-foreground mt-0.5">{caption}</div> : null}
    </div>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

function CompareTable({ rows, labelHead }: { rows: { label: string; cur: number; prev: number }[]; labelHead: string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">Nothing recorded in either period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            <th className="py-2 font-medium">{labelHead}</th>
            <th className="py-2 font-medium text-right">This week</th>
            <th className="py-2 font-medium text-right">Previous week</th>
            <th className="py-2 font-medium text-right">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = pctChange(r.cur, r.prev);
            return (
              <tr key={r.label} className="border-b border-border/50 last:border-0">
                <td className="py-2 pr-2">{r.label}</td>
                <td className="py-2 text-right tabular-nums">{fmt(r.cur)}</td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">{fmt(r.prev)}</td>
                <td className={`py-2 text-right tabular-nums ${p === null ? 'text-muted-foreground' : p >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                  {p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AccountTable({ lines, empty }: { lines: WeeklyAccountLine[]; empty: string }) {
  if (!lines.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            <th className="py-2 font-medium">Account</th>
            <th className="py-2 font-medium text-right">Opening</th>
            <th className="py-2 font-medium text-right">Closing</th>
            <th className="py-2 font-medium text-right">Change</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.account_code} className="border-b border-border/50 last:border-0">
              <td className="py-2 pr-2"><span className="text-muted-foreground">{l.account_code}</span> {l.label}</td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">{fmt(l.opening)}</td>
              <td className="py-2 text-right tabular-nums">{fmt(l.closing)}</td>
              <td className={`py-2 text-right tabular-nums ${l.closing - l.opening >= 0 ? '' : 'text-destructive'}`}>{fmt(l.closing - l.opening)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * General Weekly CFO Report — a reporting layer over `get_cfo_weekly_report`.
 * Every figure comes straight from the ledger-backed RPC; nothing is computed twice.
 */
export default function CFOWeeklyReportPanel() {
  const [exporting, setExporting] = useState(false);
  const weeks = useMemo(() => weekOptions(12), []);
  // Default: the last completed Monday-to-Sunday week.
  const [weekStart, setWeekStart] = useState<string>(() => weeks[1].value);

  const { data: report, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['cfo-weekly-report', weekStart],
    queryFn: async (): Promise<CfoWeeklyReport> => {
      const { data, error: rpcError } = await supabase.rpc('get_cfo_weekly_report', { p_week_start: weekStart });
      if (rpcError) throw rpcError;
      return data as unknown as CfoWeeklyReport;
    },
    staleTime: 5 * 60 * 1000,
  });

  const derived = useMemo(() => (report ? deriveRisksAndActions(report) : { risks: [], actions: [] }), [report]);

  const chartData = useMemo(
    () => (report?.daily_flow ?? []).map((d) => ({
      label: format(new Date(`${d.day}T12:00:00`), 'dd MMM'),
      inflow: d.inflow,
      outflow: d.outflow,
      net: d.net,
    })),
    [report],
  );

  const handleExport = async () => {
    if (!report) return;
    setExporting(true);
    try {
      const blob = await generateCfoWeeklyReportPdf(report);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `weekly-cfo-report-${report.period.week_start}-to-${report.period.week_end}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success('Weekly CFO report downloaded');
    } catch (e: any) {
      toast.error(e?.message || 'Could not build the PDF');
    } finally {
      setExporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-6 text-sm text-destructive">
          {(error as any)?.message || 'The weekly CFO report could not be loaded.'}
        </CardContent>
      </Card>
    );
  }

  const { cash, cash_flow: cf, profit_and_loss: pnl, position, receivables, payables } = report;
  const reconVariance = cash.opening_cash + cash.net_change - cash.closing_cash;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight">General Weekly CFO Report</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {dateOnly(report.period.week_start)} – {dateOnly(report.period.week_end)} (Monday to Sunday, Kampala time) · compared with {dateOnly(report.previous_period.week_start)} – {dateOnly(report.previous_period.week_end)}
          </p>
          {!report.period.complete && (
            <Badge variant="outline" className="mt-1 text-[10px]">Week in progress: figures to {format(new Date(report.period.to), 'dd MMM, HH:mm')}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={weekStart} onValueChange={setWeekStart}>
            <SelectTrigger className="h-9 w-[250px] rounded-xl text-xs" aria-label="Reporting week">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {weeks.map((w) => (
                <SelectItem key={w.value} value={w.value} className="text-xs">{w.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-9 rounded-xl gap-2 text-xs" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Button size="sm" className="h-9 rounded-xl gap-2 text-xs" onClick={handleExport} disabled={exporting}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export PDF
          </Button>
        </div>
      </div>

      {/* Executive summary */}
      <SectionCard title="Executive Summary" subtitle={report.basis}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-5">
          <Metric label="Opening cash" value={fmt(cash.opening_cash)} caption={`Monday ${dateOnly(report.period.week_start)}, 00:00`} />
          <Metric label="Closing cash" value={fmt(cash.closing_cash)} caption={report.period.complete ? `End of Sunday ${dateOnly(report.period.week_end)}` : `To ${format(new Date(report.period.to), 'dd MMM, HH:mm')}`} />
          <Metric
            label="Net cash movement"
            value={fmt(cash.net_change)}
            tone={cash.net_change >= 0 ? 'text-emerald-600' : 'text-destructive'}
            caption={<Delta current={cf.net} previous={cf.prev_net} />}
          />
          <Metric label="Cash legs recorded" value={String(cf.legs)} caption={`${cf.prev_legs} last week`} />
          <Metric label="Revenue" value={fmt(pnl.revenue)} tone="text-emerald-600" caption={<Delta current={pnl.revenue} previous={pnl.prev_revenue} />} />
          <Metric label="Expenses" value={fmt(pnl.expenses)} tone="text-orange-600" caption={<Delta current={pnl.expenses} previous={pnl.prev_expenses} />} />
          <Metric label="Net result" value={fmt(pnl.net_result)} tone={pnl.net_result >= 0 ? 'text-emerald-600' : 'text-destructive'} caption={`Margin ${marginText(pnl.net_margin, pnl.revenue)} (was ${marginText(pnl.prev_net_margin, pnl.prev_revenue)})`} />
          <Metric label="Net working capital" value={fmt(position.net_working_capital)} caption="Current assets − current liabilities" />
        </div>
      </SectionCard>

      {/* Position */}
      <SectionCard title="Position at Period End" subtitle="Cash on the CFO Home treasury card basis; obligations from the Statement of Financial Position">
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-x-6 gap-y-5">
          <Metric label="Money we have" value={fmt(position.money_we_have)} tone="text-emerald-600" caption="A1 + A5" />
          <Metric label="Money in treasury / platform" value={fmt(position.money_in_treasury)} tone="text-indigo-600" caption="Cash held outside the bank" />
          <Metric label="Money in bank" value={fmt(position.money_in_bank)} tone="text-sky-600" caption="Net banked cash" />
          <Metric label="Landlord float pool" value={fmt(position.landlord_pool)} caption="A21 + A22, held for landlords" />
          <Metric label="Money we owe" value={fmt(position.money_we_owe)} tone="text-orange-600" caption="Current liabilities" />
          <Metric label="Money we can use" value={fmt(position.money_we_can_use)} tone="text-blue-600" caption="Cash after current liabilities" />
        </div>
      </SectionCard>

      {/* Cash & liquidity */}
      <SectionCard title="Cash & Liquidity" subtitle="Opening and closing positions reconcile to the ledger">
        <CompareTable
          labelHead="Measure"
          rows={[
            { label: 'Total cash (A1 + A5)', cur: cash.closing_cash, prev: cash.opening_cash },
            { label: 'Money in bank', cur: cash.closing_bank, prev: cash.opening_bank },
            { label: 'Money in treasury / platform', cur: cash.closing_treasury, prev: cash.opening_treasury },
            { label: 'A1 cash and bank', cur: cash.closing_a1, prev: cash.opening_a1 },
            { label: 'A5 cash in transit', cur: cash.closing_a5, prev: cash.opening_a5 },
            { label: 'Landlord float pool (A21 + A22)', cur: cash.closing_pool, prev: cash.opening_pool },
            { label: 'Total including landlord pool', cur: cash.closing_incl_pool, prev: cash.opening_incl_pool },
          ]}
        />
        <p className={`text-[11px] mt-3 ${Math.abs(reconVariance) < 1 ? 'text-emerald-600' : 'text-destructive'}`}>
          {Math.abs(reconVariance) < 1
            ? `Reconciled: opening ${fmt(cash.opening_cash)} + movement ${fmt(cash.net_change)} = closing ${fmt(cash.closing_cash)}.`
            : `Reconciliation variance of ${fmt(reconVariance)} — review the Full Ledger.`}
        </p>
        <p className="text-[11px] text-muted-foreground mt-1">
          Columns above compare closing against opening for the same week, not against the previous week.
        </p>
      </SectionCard>

      {/* Cash flow */}
      <SectionCard title="Cash Flow" subtitle="Inflows and outflows against the previous Monday-to-Sunday week">
        <CompareTable
          labelHead="Cash flow"
          rows={[
            { label: 'Inflows', cur: cf.inflows, prev: cf.prev_inflows },
            { label: 'Outflows', cur: cf.outflows, prev: cf.prev_outflows },
            { label: 'Net cash movement', cur: cf.net, prev: cf.prev_net },
          ]}
        />
        {chartData.length > 0 && (
          <div className="h-[260px] mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tickFormatter={(v: number) => fmtShort(v)} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={54} />
                <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="inflow" name="Inflow" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="outflow" name="Outflow" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="net" name="Net" stroke="hsl(var(--foreground))" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Revenue Performance" subtitle={`Total ${fmt(pnl.revenue)} this week · revenue accounts (R)`}>
          <CompareTable
            labelHead="Revenue category"
            rows={report.revenue_lines.slice(0, 12).map((l) => ({ label: `${l.account_code} · ${prettyCategory(l.category)}`, cur: l.amount, prev: l.prev_amount }))}
          />
        </SectionCard>
        <SectionCard
          title="Expense Performance"
          subtitle={`Total ${fmt(pnl.expenses)} this week · expense accounts (X)${pnl.float_restatement ? ` · includes ${fmt(pnl.float_restatement)} float restatement (X6)` : ''}`}
        >
          <CompareTable
            labelHead="Expense category"
            rows={report.expense_lines.slice(0, 12).map((l) => ({ label: `${l.account_code} · ${prettyCategory(l.category)}`, cur: l.amount, prev: l.prev_amount }))}
          />
        </SectionCard>
      </div>

      {/* Receivables & payables */}
      <SectionCard title="Receivables & Payables" subtitle="Balance-sheet accounts: opening (Monday 00:00) and closing (end of the week)">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5">
          <Metric label="Rent Plan receivables" value={fmt(receivables.tenant_outstanding)} caption={<Delta current={receivables.tenant_outstanding} previous={receivables.opening_tenant_outstanding} />} />
          <Metric label="Agent advances receivable" value={fmt(receivables.advances_outstanding)} caption={`A10 + A11 + A20 · ${receivables.advances_active_count} active advance(s)`} />
          <Metric label="Total receivables" value={fmt(receivables.total)} tone="text-amber-600" caption={`Includes ${fmt(receivables.other)} in other receivable accounts`} />
          <Metric label="Current liabilities" value={fmt(payables.total)} tone="text-orange-600" caption={`Wallet custody (L1) ${fmt(payables.wallet_total)}`} />
          <Metric label="Supporter capital held (L2)" value={fmt(payables.supporter_capital)} caption="Non-current; not in current liabilities" />
          <Metric label="Pending wallet operations" value={fmt(payables.pending_operations_amount)} caption={`${payables.pending_operations_count} pending`} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-5">
          <div>
            <p className="text-xs font-medium mb-1">Receivable accounts</p>
            <AccountTable lines={receivables.lines} empty="No receivable balances." />
          </div>
          <div>
            <p className="text-xs font-medium mb-1">Current liability accounts</p>
            <AccountTable lines={payables.lines} empty="No current liability balances." />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-3">
          Net working capital {fmt(position.net_working_capital)} = current assets {fmt(position.current_assets)} − current liabilities {fmt(position.current_liabilities)}
          {' '}(opening {fmt(position.opening_net_working_capital)}), as on the Statement of Financial Position.
        </p>
      </SectionCard>

      {/* Movements */}
      <SectionCard title="Significant Financial Movements" subtitle="Net cash movement by ledger category, this week vs last week">
        <CompareTable
          labelHead="Category"
          rows={report.movements.slice(0, 15).map((m) => ({ label: prettyCategory(m.category), cur: m.net, prev: m.prev_net }))}
        />
      </SectionCard>

      {/* Major transactions */}
      <SectionCard title="Major Transactions" subtitle="Largest individual cash entries in the reporting week">
        {report.major_transactions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No cash transactions recorded in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Category</th>
                  <th className="py-2 font-medium">Details</th>
                  <th className="py-2 font-medium">Flow</th>
                  <th className="py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {report.major_transactions.map((t, i) => (
                  <tr key={`${t.reference || 'tx'}-${i}`} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-2 whitespace-nowrap">{format(new Date(t.date), 'dd MMM, HH:mm')}</td>
                    <td className="py-2 pr-2">{prettyCategory(t.category)}</td>
                    <td className="py-2 pr-2 max-w-[280px] truncate">{t.description || t.reference || '—'}</td>
                    <td className="py-2 pr-2">
                      <Badge variant={t.flow === 'inflow' ? 'default' : 'destructive'} className="text-[10px]">
                        {t.flow === 'inflow' ? 'In' : 'Out'}
                      </Badge>
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium">{fmt(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Key Financial Risks / Issues" subtitle="Derived from this week's reported figures">
          <ul className="space-y-3">
            {derived.risks.map((r) => (
              <li key={r.title} className="flex gap-2">
                <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${r.severity === 'high' ? 'text-destructive' : r.severity === 'medium' ? 'text-amber-600' : 'text-muted-foreground'}`} />
                <div>
                  <p className="text-xs font-medium">{r.title}</p>
                  <p className="text-[11px] text-muted-foreground">{r.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard title="CFO Actions & Recommendations" subtitle="For discussion with management">
          <ol className="space-y-2 list-decimal pl-4">
            {derived.actions.map((a) => (
              <li key={a} className="text-xs text-muted-foreground">{a}</li>
            ))}
          </ol>
        </SectionCard>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Reporting layer only — no accounting logic, records or workflows are changed by this report.
        Figures are read from the general ledger and existing finance tables at {format(new Date(report.generated_at), 'dd MMM yyyy, HH:mm')}.
      </p>
    </div>
  );
}
