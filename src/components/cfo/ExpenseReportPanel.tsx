import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  addDays, addMonths, addQuarters, addWeeks, addYears,
  endOfMonth, endOfQuarter, endOfWeek, endOfYear,
  format, getQuarter, startOfMonth, startOfQuarter, startOfWeek, startOfYear,
} from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, FileDown, Printer, RefreshCw, Loader2, ChevronLeft, ChevronRight, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import {
  generateExpenseReportPdf,
  type ExpenseReportRow,
  type ExpenseReportSummaryRow,
} from '@/lib/expenseReportPdf';

/** Expense categories already recorded on the platform ledger (read-only). */
const EXPENSE_CATEGORIES: { category: string; label: string }[] = [
  { category: 'marketing_expense', label: 'Marketing & Customer Acquisition' },
  { category: 'payroll_expense', label: 'Payroll & Salaries' },
  { category: 'general_admin_expense', label: 'General & Admin' },
  { category: 'research_development_expense', label: 'Research & Development' },
  { category: 'tax_expense', label: 'Taxes' },
  { category: 'interest_expense', label: 'Interest Expense' },
  { category: 'equipment_expense', label: 'Equipment & Capex' },
  { category: 'roi_expense', label: 'Supporter Returns Paid' },
  { category: 'agent_commission_earned', label: 'Agent Commissions' },
  { category: 'platform_expense', label: 'Platform Expense' },
  { category: 'platform_expense_disbursement', label: 'Platform Expense Disbursement' },
  { category: 'transaction_platform_expenses', label: 'Transaction & Platform Expenses (legacy)' },
  { category: 'operational_expenses', label: 'Operational Expenses (legacy)' },
];

const LABELS = new Map(EXPENSE_CATEGORIES.map((c) => [c.category, c.label]));
const PAGE = 1000;
const MAX_PAGES = 25;

type PeriodKind = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';

const PERIOD_OPTIONS: { value: PeriodKind; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom range' },
];

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/** Pure derivation of the reporting window + label for a period + anchor date. */
function resolvePeriod(kind: PeriodKind, anchor: Date): { from: string; to: string; label: string } {
  switch (kind) {
    case 'daily':
      return { from: iso(anchor), to: iso(anchor), label: format(anchor, 'd MMMM yyyy') };
    case 'weekly': {
      const s = startOfWeek(anchor, { weekStartsOn: 1 });
      const e = endOfWeek(anchor, { weekStartsOn: 1 });
      return {
        from: iso(s),
        to: iso(e),
        label: `Week of ${format(s, 'd MMM')}–${format(e, 'd MMM yyyy')}`,
      };
    }
    case 'monthly':
      return { from: iso(startOfMonth(anchor)), to: iso(endOfMonth(anchor)), label: format(anchor, 'MMMM yyyy') };
    case 'quarterly':
      return {
        from: iso(startOfQuarter(anchor)),
        to: iso(endOfQuarter(anchor)),
        label: `Q${getQuarter(anchor)} ${format(anchor, 'yyyy')}`,
      };
    case 'yearly':
      return { from: iso(startOfYear(anchor)), to: iso(endOfYear(anchor)), label: format(anchor, 'yyyy') };
    default:
      return { from: '', to: '', label: 'Custom range' };
  }
}

const shift = (kind: PeriodKind, anchor: Date, dir: 1 | -1): Date => {
  switch (kind) {
    case 'daily': return addDays(anchor, dir);
    case 'weekly': return addWeeks(anchor, dir);
    case 'monthly': return addMonths(anchor, dir);
    case 'quarterly': return addQuarters(anchor, dir);
    case 'yearly': return addYears(anchor, dir);
    default: return anchor;
  }
};

interface RawRow {
  id: string;
  transaction_date: string;
  created_at: string;
  amount: number;
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  account: string | null;
  classification: string | null;
}

/**
 * READ-ONLY CFO expense report over the expense entries already recorded in
 * `general_ledger`. It never writes and never touches any expense workflow.
 */
export function ExpenseReportPanel() {
  const [periodKind, setPeriodKind] = useState<PeriodKind>('monthly');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState<'pdf' | 'print' | null>(null);

  const resolved = useMemo(() => resolvePeriod(periodKind, anchor), [periodKind, anchor]);
  const from = periodKind === 'custom' ? customFrom : resolved.from;
  const to = periodKind === 'custom' ? customTo : resolved.to;
  const periodLabel = periodKind === 'custom'
    ? (customFrom || customTo
        ? `${customFrom ? format(new Date(customFrom), 'd MMM yyyy') : 'earliest'} – ${customTo ? format(new Date(customTo), 'd MMM yyyy') : 'latest'}`
        : 'All recorded expenses')
    : resolved.label;

  const { data: rows = [], isLoading, isRefetching, refetch } = useQuery({
    queryKey: ['cfo-expense-report', from, to],
    queryFn: async (): Promise<RawRow[]> => {
      const all: RawRow[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        let q = supabase
          .from('general_ledger')
          .select('id, transaction_date, created_at, amount, category, description, reference_id, linked_party, account, classification')
          .in('category', EXPENSE_CATEGORIES.map((c) => c.category))
          .eq('direction', 'cash_out');
        if (from) q = q.gte('transaction_date', `${from}T00:00:00Z`);
        if (to) q = q.lte('transaction_date', `${to}T23:59:59Z`);
        const { data, error } = await q
          .order('transaction_date', { ascending: false })
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) throw error;
        const batch = (data ?? []) as unknown as RawRow[];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      return all;
    },
    staleTime: 60_000,
  });

  const statusOf = (r: RawRow) =>
    r.classification === 'admin_correction' ? 'Adjustment' : 'Approved & posted';

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (category !== 'all' && r.category !== category) return false;
      if (status !== 'all' && statusOf(r) !== status) return false;
      if (term) {
        const hay = `${r.description ?? ''} ${r.reference_id ?? ''} ${r.linked_party ?? ''} ${r.account ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [rows, category, status, search]);

  const reportRows: ExpenseReportRow[] = useMemo(
    () => filtered.map((r) => ({
      reference: r.reference_id || `GL-${r.id.slice(0, 8).toUpperCase()}`,
      date: r.transaction_date || r.created_at,
      categoryLabel: LABELS.get(r.category) || r.category,
      description: r.description || undefined,
      amount: Number(r.amount) || 0,
      status: statusOf(r),
      payee: r.linked_party || undefined,
      account: r.account || undefined,
    })),
    [filtered],
  );

  const summary: ExpenseReportSummaryRow[] = useMemo(() => {
    const map = new Map<string, ExpenseReportSummaryRow>();
    for (const r of reportRows) {
      const cur = map.get(r.categoryLabel) || { categoryLabel: r.categoryLabel, count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += r.amount;
      map.set(r.categoryLabel, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
  }, [reportRows]);

  const total = reportRows.reduce((s, r) => s + r.amount, 0);
  const largest = reportRows.reduce((m, r) => Math.max(m, r.amount), 0);

  const buildPdf = async () =>
    generateExpenseReportPdf(reportRows, summary, { from, to, category, status, search, periodLabel });

  const handleExport = async () => {
    if (!reportRows.length) { toast.error('No expenses match the selected filters'); return; }
    setExporting('pdf');
    try {
      const blob = await buildPdf();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `expense-report-${periodLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`Report exported — ${reportRows.length} expense records`);
    } catch (e) {
      toast.error((e as Error).message || 'Failed to export report');
    } finally {
      setExporting(null);
    }
  };

  const handlePrint = async () => {
    if (!reportRows.length) { toast.error('No expenses match the selected filters'); return; }
    setExporting('print');
    try {
      const blob = await buildPdf();
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      if (!win) toast.error('Allow pop-ups to print the report');
      else win.addEventListener('load', () => win.print());
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error((e as Error).message || 'Failed to prepare print view');
    } finally {
      setExporting(null);
    }
  };

  const visible = reportRows.slice(0, 500);
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 8 }, (_, i) => currentYear - i);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Expense Report
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Read-only report of every expense already recorded in the system. Choose a reporting
            period, filter, refresh, print or export as PDF — nothing here changes an expense or
            its approval.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Period selector */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <div>
              <label className="text-[11px] text-muted-foreground">Reporting period</label>
              <Select value={periodKind} onValueChange={(v) => setPeriodKind(v as PeriodKind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent className="z-[200]">
                  {PERIOD_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {periodKind === 'daily' && (
              <div>
                <label className="text-[11px] text-muted-foreground">Select date</label>
                <Input
                  type="date"
                  value={iso(anchor)}
                  onChange={(e) => e.target.value && setAnchor(new Date(`${e.target.value}T00:00:00`))}
                />
              </div>
            )}

            {periodKind === 'weekly' && (
              <div>
                <label className="text-[11px] text-muted-foreground">Select week (any day in it)</label>
                <Input
                  type="date"
                  value={iso(anchor)}
                  onChange={(e) => e.target.value && setAnchor(new Date(`${e.target.value}T00:00:00`))}
                />
              </div>
            )}

            {periodKind === 'monthly' && (
              <div>
                <label className="text-[11px] text-muted-foreground">Select month</label>
                <Input
                  type="month"
                  value={format(anchor, 'yyyy-MM')}
                  onChange={(e) => e.target.value && setAnchor(new Date(`${e.target.value}-01T00:00:00`))}
                />
              </div>
            )}

            {periodKind === 'quarterly' && (
              <>
                <div>
                  <label className="text-[11px] text-muted-foreground">Quarter</label>
                  <Select
                    value={String(getQuarter(anchor))}
                    onValueChange={(v) => setAnchor(new Date(anchor.getFullYear(), (Number(v) - 1) * 3, 1))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="z-[200]">
                      {[1, 2, 3, 4].map((q) => (
                        <SelectItem key={q} value={String(q)}>Q{q}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Year</label>
                  <Select
                    value={String(anchor.getFullYear())}
                    onValueChange={(v) => setAnchor(new Date(Number(v), anchor.getMonth(), 1))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="z-[200]">
                      {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {periodKind === 'yearly' && (
              <div>
                <label className="text-[11px] text-muted-foreground">Select year</label>
                <Select
                  value={String(anchor.getFullYear())}
                  onValueChange={(v) => setAnchor(new Date(Number(v), 0, 1))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="z-[200]">
                    {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {periodKind === 'custom' && (
              <>
                <div>
                  <label className="text-[11px] text-muted-foreground">From</label>
                  <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">To</label>
                  <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                </div>
              </>
            )}
          </div>

          {/* Period navigation + resolved range */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={periodKind === 'custom'}
              onClick={() => setAnchor((a) => shift(periodKind, a, -1))}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous period
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={periodKind === 'custom'}
              onClick={() => setAnchor((a) => shift(periodKind, a, 1))}
            >
              Next period
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={periodKind === 'custom'}
              onClick={() => setAnchor(new Date())}
            >
              <CalendarClock className="h-4 w-4 mr-1" />
              {periodKind === 'daily' ? 'Today' : 'Current period'}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {from || 'earliest'} → {to || 'latest'}
            </span>
          </div>

          <h3 className="text-sm font-semibold">Expenses — {periodLabel}</h3>

          {/* Filters */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="text-[11px] text-muted-foreground">Category</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue placeholder="All categories" /></SelectTrigger>
                <SelectContent className="z-[200]">
                  <SelectItem value="all">All categories</SelectItem>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <SelectItem key={c.category} value={c.category}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Status</label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent className="z-[200]">
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="Approved & posted">Approved &amp; posted</SelectItem>
                  <SelectItem value="Adjustment">Adjustment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Search</label>
              <Input placeholder="Details, reference, payee" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void handleExport()} disabled={!!exporting || isLoading}>
              {exporting === 'pdf' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileDown className="h-4 w-4 mr-1" />}
              Download PDF — {periodLabel}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handlePrint()} disabled={!!exporting || isLoading}>
              {exporting === 'print' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Printer className="h-4 w-4 mr-1" />}
              Print
            </Button>

            <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isRefetching}>
              <RefreshCw className={`h-4 w-4 mr-1 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {(category !== 'all' || status !== 'all' || search) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setCategory('all'); setStatus('all'); setSearch(''); }}
              >
                Clear filters
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Expense records</p>
              <p className="text-lg font-bold">{reportRows.length.toLocaleString('en-US')}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Total expenses</p>
              <p className="text-lg font-bold">{formatUGX(total)}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Largest single expense</p>
              <p className="text-lg font-bold">{formatUGX(largest)}</p>
            </div>
          </div>

          {summary.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {summary.map((s) => (
                <Badge key={s.categoryLabel} variant="secondary" className="text-[11px]">
                  {s.categoryLabel}: {s.count} · {formatUGX(s.amount)}
                </Badge>
              ))}
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  {['Reference', 'Date & time', 'Category', 'Details / purpose', 'Payee', 'Account', 'Status', 'Amount'].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">Loading expenses…</td></tr>
                )}
                {!isLoading && reportRows.length === 0 && (
                  <tr><td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">No expenses recorded for {periodLabel} with the selected filters.</td></tr>
                )}
                {visible.map((r, i) => (
                  <tr key={`${r.reference}-${i}`} className="border-t border-border/60">
                    <td className="px-2 py-2 font-mono whitespace-nowrap">{r.reference}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{new Date(r.date as string).toLocaleString('en-GB')}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.categoryLabel}</td>
                    <td className="px-2 py-2 max-w-[260px]">{r.description || '—'}</td>
                    <td className="px-2 py-2">{r.payee || '—'}</td>
                    <td className="px-2 py-2">{r.account || '—'}</td>
                    <td className="px-2 py-2"><Badge variant="outline" className="text-[10px]">{r.status}</Badge></td>
                    <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{formatUGX(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reportRows.length > visible.length && (
            <p className="text-[11px] text-muted-foreground">
              Showing the first {visible.length.toLocaleString('en-US')} of{' '}
              {reportRows.length.toLocaleString('en-US')} records on screen — the PDF export
              includes every matching record.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default ExpenseReportPanel;
