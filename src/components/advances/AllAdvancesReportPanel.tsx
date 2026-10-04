import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Search, Download, FileText, ChevronLeft, ChevronRight, CalendarIcon } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { DateRange } from 'react-day-picker';

interface AdvanceRow {
  advance_id: string;
  reference: string;
  advance_type: string;
  recipient_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  amount_requested: number | null;
  amount_approved: number | null;
  amount_paid: number | null;
  outstanding_balance: number | null;
  requested_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  paid_at: string | null;
  status: string;
  transaction_reference: string | null;
  notes: string | null;
}

const STATUS_TONE: Record<string, string> = {
  cfo_paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  completed: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  reimbursed: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  cfo_approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  pending_cfo: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  overdue: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cfo_rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
  voided: 'bg-muted text-muted-foreground',
};

const prettyStatus = (s: string) => (s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Local (EAT) yyyy-mm-dd for a Date */
const isoDay = (d: Date) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
};

type Period = 'all' | 'today' | 'week' | 'month' | 'calendar' | 'custom';

const PERIOD_LABELS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Daily' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
  { key: 'all', label: 'All time' },
];

const periodRange = (p: Period): { from: string; to: string } => {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  switch (p) {
    case 'today': {
      const d = startOfDay(now);
      return { from: isoDay(d), to: isoDay(d) };
    }
    case 'week': {
      const day = now.getDay(); // 0 = Sun
      const diff = day === 0 ? 6 : day - 1; // week starts Monday
      const start = startOfDay(new Date(now.getTime() - diff * 86_400_000));
      return { from: isoDay(start), to: isoDay(now) };
    }
    case 'month':
      return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDay(now) };
    default:
      return { from: '', to: '' };
  }
};

const fmtDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const money = (v: number | null) => (v == null ? '—' : formatUGX(Number(v)));

/**
 * Company-wide Advances report: every advance recorded in the system
 * (agent advances, direct issues, business advances, credit access draws,
 * staff salary advances, merchant out-of-pocket advances) in one filterable
 * table. Read-only — it calls the reporting RPC and changes nothing.
 */
export function AllAdvancesReportPanel() {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search, 250);

  const { data, isLoading, error } = useQuery({
    queryKey: ['all-advances-report'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_all_advances_report' as any);
      if (error) throw error;
      return (data ?? []) as AdvanceRow[];
    },
  });

  const rows = data ?? [];

  const types = useMemo(
    () => Array.from(new Set(rows.map((r) => r.advance_type))).sort(),
    [rows],
  );
  const statuses = useMemo(
    () => Array.from(new Set(rows.map((r) => r.status).filter(Boolean))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const fromTs = from ? new Date(from + 'T00:00:00').getTime() : null;
    const toTs = to ? new Date(to + 'T23:59:59').getTime() : null;
    return rows
      .filter((r) => (type === 'all' ? true : r.advance_type === type))
      .filter((r) => (status === 'all' ? true : r.status === status))
      .filter((r) => {
        if (!fromTs && !toTs) return true;
        const t = r.requested_at ? new Date(r.requested_at).getTime() : null;
        if (t == null) return false;
        if (fromTs && t < fromTs) return false;
        if (toTs && t > toTs) return false;
        return true;
      })
      .filter((r) => {
        if (!needle) return true;
        return [r.reference, r.recipient_name, r.recipient_phone, r.transaction_reference, r.advance_id, r.status]
          .some((v) => (v || '').toLowerCase().includes(needle));
      })
      .sort((a, b) => new Date(b.requested_at || 0).getTime() - new Date(a.requested_at || 0).getTime());
  }, [rows, type, status, from, to, q]);

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, r) => ({
          requested: acc.requested + Number(r.amount_requested || 0),
          approved: acc.approved + Number(r.amount_approved || 0),
          paid: acc.paid + Number(r.amount_paid || 0),
          outstanding: acc.outstanding + Number(r.outstanding_balance || 0),
        }),
        { requested: 0, approved: 0, paid: 0, outstanding: 0 },
      ),
    [filtered],
  );

  const reportScope = () =>
    period === 'calendar'
      ? from || to
        ? `calendar-${from || to}`
        : 'calendar'
      : period === 'custom' || period === 'all'
        ? from || to
          ? `${from || 'start'}_to_${to || 'today'}`
          : 'all-time'
        : period;

  const REPORT_HEAD = [
      'Reference', 'Advance Type', 'Recipient Name', 'Recipient Phone', 'Amount Requested',
      'Amount Approved', 'Amount Paid', 'Outstanding', 'Date Requested', 'Date Approved',
      'Date Rejected', 'Date Paid', 'Status', 'Transaction Reference', 'Notes',
  ];

  const reportRows = () =>
    filtered.map((r) => [
      r.reference, r.advance_type, r.recipient_name, r.recipient_phone,
      r.amount_requested ?? '', r.amount_approved ?? '', r.amount_paid ?? '',
      r.outstanding_balance ?? '', r.requested_at ?? '', r.approved_at ?? '',
      r.rejected_at ?? '', r.paid_at ?? '', r.status, r.transaction_reference ?? '', r.notes ?? '',
    ]);

  const exportCsv = () => {
    const head = REPORT_HEAD;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      head.join(','),
      ...reportRows().map((row) => row.map(esc).join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    const scope = reportScope();
    const filename = `advances-report-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Bulk export of every advance -- recipient names, phones, amounts --
    // not logged before this. Plain client-side insert so the audit_logs
    // IP-capture trigger sees the real browser IP directly. Never blocks
    // the actual download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'export',
          record_id: null,
          metadata: { filename, row_count: filtered.length },
        });
      } catch (e) {
        console.warn('[AllAdvancesReportPanel] audit log insert failed:', e);
      }
    })();
  };

  const [pdfBusy, setPdfBusy] = useState(false);

  const exportPdf = async () => {
    setPdfBusy(true);
    try {
      const { downloadAuditPdf } = await import('@/lib/pdfAuditReport');
      const scope = reportScope();
      const filters = [
        `Period: ${period === 'calendar' || period === 'custom' ? `${from || 'start'} → ${to || 'today'}` : (PERIOD_LABELS.find((p) => p.key === period)?.label ?? period)}`,
        `Type: ${type === 'all' ? 'All types' : type}`,
        `Status: ${status === 'all' ? 'All statuses' : prettyStatus(status)}`,
      ];
      if (q) filters.push(`Search: ${q}`);
      await downloadAuditPdf(
        `advances-report-${scope}-${new Date().toISOString().slice(0, 10)}.pdf`,
        REPORT_HEAD,
        reportRows(),
        {
          title: 'All Advances Report',
          subtitle: 'Generated by Welile CFO Office',
          filters,
          footerLabel: 'Welile — All Advances Report',
          kpis: [
            { label: 'Requested', value: formatUGX(totals.requested) },
            { label: 'Approved', value: formatUGX(totals.approved), accent: [22, 132, 92] },
            { label: 'Paid', value: formatUGX(totals.paid), accent: [30, 100, 200] },
            { label: 'Outstanding', value: formatUGX(totals.outstanding), accent: [200, 80, 30] },
          ],
        },
      );
    } finally {
      setPdfBusy(false);
    }
  };

  const clearAll = () => {
    setSearch(''); setType('all'); setStatus('all'); setFrom(''); setTo(''); setPeriod('all'); setDateRange(undefined);
  };

  const applyPeriod = (p: Period) => {
    setPeriod(p);
    if (p === 'calendar') {
      if (dateRange?.from) {
        setFrom(isoDay(dateRange.from));
        setTo(dateRange.to ? isoDay(dateRange.to) : isoDay(dateRange.from));
      }
      return;
    }
    const r = periodRange(p);
    setFrom(r.from);
    setTo(r.to);
  };

  const applyDateRange = (range: DateRange | undefined) => {
    setDateRange(range);
    if (range?.from) {
      setFrom(isoDay(range.from));
      setTo(range.to ? isoDay(range.to) : isoDay(range.from));
      setPeriod('calendar');
    }
  };

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [q, type, status, from, to]);

  const pageNumbers = useMemo(() => {
    const out: (number | 'gap')[] = [];
    const push = (n: number) => { if (!out.includes(n)) out.push(n); };
    push(1);
    for (let n = safePage - 2; n <= safePage + 2; n++) if (n > 1 && n < totalPages) push(n);
    if (totalPages > 1) push(totalPages);
    const sorted = (out.filter((v) => typeof v === 'number') as number[]).sort((a, b) => a - b);
    const withGaps: (number | 'gap')[] = [];
    sorted.forEach((n, i) => {
      if (i > 0 && n - sorted[i - 1] > 1) withGaps.push('gap');
      withGaps.push(n);
    });
    return withGaps;
  }, [safePage, totalPages]);

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4" /> All Advances Report
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Every advance recorded in the system — agent, business, credit access, staff salary and merchant out-of-pocket.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length} className="gap-2">
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button size="sm" onClick={exportPdf} disabled={!filtered.length || pdfBusy} className="gap-2">
            <FileText className="h-4 w-4" /> {pdfBusy ? 'Preparing…' : 'Download PDF'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PERIOD_LABELS.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={period === p.key ? 'default' : 'outline'}
            className="h-7 px-2.5 text-[11px]"
            onClick={() => applyPeriod(p.key)}
          >
            {p.label}
          </Button>
        ))}
        {(period === 'calendar' || period === 'custom') && (
          <Badge variant="secondary" className="text-[10px]">Custom range</Badge>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reference, name, phone, txn"
            className="pl-8 h-9"
          />
        </div>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="h-9"><SelectValue placeholder="Advance type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {types.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-9"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statuses.map((s) => <SelectItem key={s} value={s}>{prettyStatus(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                'h-9 justify-start text-left font-normal',
                !dateRange?.from && 'text-muted-foreground',
              )}
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {dateRange?.from ? (
                dateRange.to ? (
                  <>
                    {format(dateRange.from, 'LLL dd')} - {format(dateRange.to, 'LLL dd, yyyy')}
                  </>
                ) : (
                  format(dateRange.from, 'PPP')
                )
              ) : (
                'Pick a date range'
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={dateRange}
              onSelect={applyDateRange}
              numberOfMonths={2}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>{filtered.length.toLocaleString()} of {rows.length.toLocaleString()} advances</span>
        <span>Requested {money(totals.requested)}</span>
        <span>Approved {money(totals.approved)}</span>
        <span>Paid {money(totals.paid)}</span>
        <span>Outstanding {money(totals.outstanding)}</span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={clearAll}>Clear filters</Button>
      </div>

      {error ? (
        <p className="text-xs text-destructive">
          Could not load the advances report: {(error as Error).message}
        </p>
      ) : isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">No advances match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                {['Reference', 'Type', 'Recipient', 'Phone', 'Requested', 'Approved', 'Paid', 'Outstanding',
                  'Date Requested', 'Date Approved', 'Date Rejected', 'Date Paid', 'Status', 'Txn Ref'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.map((r) => (
                <tr key={`${r.advance_type}-${r.advance_id}`} className="border-b border-border/30">
                  <td className="px-2 py-2 font-mono whitespace-nowrap">{r.reference}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.advance_type}</td>
                  <td className="px-2 py-2">{r.recipient_name || '—'}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.recipient_phone || '—'}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{money(r.amount_requested)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{money(r.amount_approved)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{money(r.amount_paid)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{money(r.outstanding_balance)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{fmtDate(r.requested_at)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{fmtDate(r.approved_at)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{fmtDate(r.rejected_at)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{fmtDate(r.paid_at)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <Badge variant="secondary" className={`border-0 ${STATUS_TONE[r.status] || 'bg-muted text-muted-foreground'}`}>
                      {prettyStatus(r.status)}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 font-mono whitespace-nowrap">
                    {r.transaction_reference ? r.transaction_reference.slice(0, 8) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
              <span className="text-[11px] text-muted-foreground">
                {((safePage - 1) * PAGE_SIZE + 1).toLocaleString()}–
                {Math.min(safePage * PAGE_SIZE, filtered.length).toLocaleString()} of {filtered.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="sm" className="h-7 w-7 p-0"
                  onClick={() => setPage(safePage - 1)} disabled={safePage === 1}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {pageNumbers.map((n, i) =>
                  n === 'gap' ? (
                    <span key={`gap-${i}`} className="px-1 text-[11px] text-muted-foreground">…</span>
                  ) : (
                    <Button
                      key={n}
                      variant={n === safePage ? 'default' : 'outline'}
                      size="sm"
                      className="h-7 min-w-7 px-2 text-[11px]"
                      onClick={() => setPage(n)}
                      aria-current={n === safePage ? 'page' : undefined}
                    >
                      {n}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline" size="sm" className="h-7 w-7 p-0"
                  onClick={() => setPage(safePage + 1)} disabled={safePage >= totalPages}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default AllAdvancesReportPanel;
