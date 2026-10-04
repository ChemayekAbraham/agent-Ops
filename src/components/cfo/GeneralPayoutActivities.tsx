import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import {
  format, startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, startOfQuarter, endOfQuarter,
  addWeeks, addMonths, addQuarters, getQuarter,
} from 'date-fns';
import {
  CalendarIcon, ChevronLeft, ChevronRight, History, Wallet, ArrowDownLeft,
  ArrowUpRight, X, Loader2, Banknote, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 10;

type PeriodKind = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'custom';
type TypeFilter = 'all' | 'credit' | 'debit';
type DestinationFilter = 'all' | 'user' | 'operational_wallet';

interface PayoutRow {
  id: string;
  operation: string;
  amount: number;
  evidence: string | null;
  reference_id: string | null;
  created_at: string;
  target_user_id: string;
  metadata: Record<string, unknown> | null;
  recipient?: { full_name: string | null; phone: string | null } | null;
}

const PERIOD_OPTIONS: { value: PeriodKind; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'custom', label: 'Custom' },
];

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

function resolvePeriod(
  kind: PeriodKind,
  anchor: Date,
  customFrom?: Date,
  customTo?: Date,
): { from: Date; to: Date; label: string } {
  switch (kind) {
    case 'daily':
      return { from: startOfDay(anchor), to: endOfDay(anchor), label: format(anchor, 'd MMMM yyyy') };
    case 'weekly': {
      const s = startOfWeek(anchor, { weekStartsOn: 1 });
      const e = endOfWeek(anchor, { weekStartsOn: 1 });
      return {
        from: startOfDay(s),
        to: endOfDay(e),
        label: `Week of ${format(s, 'd MMM')}–${format(e, 'd MMM yyyy')}`,
      };
    }
    case 'monthly':
      return {
        from: startOfDay(startOfMonth(anchor)),
        to: endOfDay(endOfMonth(anchor)),
        label: format(anchor, 'MMMM yyyy'),
      };
    case 'quarterly':
      return {
        from: startOfDay(startOfQuarter(anchor)),
        to: endOfDay(endOfQuarter(anchor)),
        label: `Q${getQuarter(anchor)} ${format(anchor, 'yyyy')}`,
      };
    case 'custom': {
      const from = customFrom ? startOfDay(customFrom) : startOfDay(new Date());
      const to = customTo ? endOfDay(customTo) : endOfDay(customFrom ?? new Date());
      return {
        from,
        to,
        label: `${format(from, 'd MMM yyyy')} – ${format(to, 'd MMM yyyy')}`,
      };
    }
  }
}

function pageWindow(current: number, total: number): (number | 'gap')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | 'gap')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('gap');
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push('gap');
  pages.push(total);
  return pages;
}

function DatePickerButton({
  value,
  onChange,
  placeholder,
}: {
  value: Date | undefined;
  onChange: (d: Date | undefined) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-9 w-full justify-start px-3 text-left text-xs font-normal sm:w-[160px]',
            !value && 'text-muted-foreground',
          )}
        >
          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
          {value ? format(value, 'dd MMM yyyy') : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={(d) => {
            onChange(d);
            setOpen(false);
          }}
          initialFocus
          className={cn('p-3 pointer-events-auto')}
        />
        {value && (
          <div className="border-t border-border p-2">
            <Button variant="ghost" size="sm" className="h-8 w-full text-xs" onClick={() => onChange(undefined)}>
              <X className="mr-1.5 h-3 w-3" />
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function GeneralPayoutActivities() {
  const [periodKind, setPeriodKind] = useState<PeriodKind>('daily');
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [dailyDate, setDailyDate] = useState<Date>(new Date());
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);

  const [page, setPage] = useState(1);
  const [nameFilter, setNameFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('credit');
  const [destinationFilter, setDestinationFilter] = useState<DestinationFilter>('all');

  const window = useMemo(
    () => resolvePeriod(periodKind, anchor, customFrom, customTo),
    [periodKind, anchor, customFrom, customTo],
  );

  const hasFilters =
    nameFilter.trim() || categoryFilter.trim() || typeFilter !== 'all' || destinationFilter !== 'all';

  const [downloading, setDownloading] = useState(false);

  // Export ALL records matching the current period + filters (ignores pagination).
  const handleDownload = async () => {
    setDownloading(true);
    try {
      let profileIds: string[] | null = null;
      if (nameFilter.trim()) {
        const { data: profiles, error: profileErr } = await supabase
          .from('profiles')
          .select('id')
          .ilike('full_name', `%${nameFilter.trim()}%`)
          .limit(1000);
        if (profileErr) throw profileErr;
        profileIds = (profiles ?? []).map((p: any) => p.id);
      }

      const buildQuery = () => {
        let q = supabase
          .from('platform_wallet_corrections')
          .select('id, operation, amount, evidence, reference_id, created_at, target_user_id, metadata')
          .gte('created_at', window.from.toISOString())
          .lte('created_at', window.to.toISOString());
        if (profileIds && profileIds.length) q = q.in('target_user_id', profileIds);
        if (categoryFilter.trim()) {
          const term = `%${categoryFilter.trim()}%`;
          q = q.or(`metadata->>category_label.ilike.${term},evidence.ilike.${term}`);
        }
        if (typeFilter !== 'all') q = q.eq('operation', typeFilter);
        if (destinationFilter !== 'all') q = q.eq('metadata->>recipient_type', destinationFilter);
        return q.order('created_at', { ascending: false });
      };

      // Page through in chunks of 1000 so large exports are not truncated.
      const allRows: PayoutRow[] = [];
      if (!profileIds || profileIds.length) {
        const CHUNK = 1000;
        for (let from = 0; ; from += CHUNK) {
          const { data: chunk, error: chunkErr } = await buildQuery().range(from, from + CHUNK - 1);
          if (chunkErr) throw chunkErr;
          allRows.push(...((chunk ?? []) as unknown as PayoutRow[]));
          if (!chunk || chunk.length < CHUNK) break;
        }
      }

      if (allRows.length === 0) {
        toast.error('No payouts to export for the selected filters.');
        return;
      }

      const ids = Array.from(new Set(allRows.map((r) => r.target_user_id).filter(Boolean)));
      const names: Record<string, { full_name: string | null; phone: string | null }> = {};
      for (let i = 0; i < ids.length; i += 500) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids.slice(i, i + 500));
        for (const p of profiles ?? []) {
          names[(p as any).id] = { full_name: (p as any).full_name, phone: (p as any).phone };
        }
      }

      const totalAmount = allRows.reduce((s, r) => s + Number(r.amount || 0), 0);

      // Always export in ascending chronological order (oldest first),
      // regardless of how the on-screen table is ordered.
      const exportRows = [...allRows].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );

      const { default: jsPDF } = await import('jspdf');
      const autoTableMod: any = await import('jspdf-autotable');
      const autoTable = autoTableMod.default || autoTableMod;

      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const marginX = 12;

      // ---- Report header ----
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(40, 20, 70);
      doc.text('General Payout Activities Report', marginX, 15);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(`Period: ${window.label}`, marginX, 21);
      doc.text(
        `Generated: ${format(new Date(), 'dd/MM/yyyy HH:mm')}`,
        pageWidth - marginX,
        21,
        { align: 'right' },
      );

      const appliedFilters: string[] = [
        `Name: ${nameFilter.trim() || 'All'}`,
        `Type: ${typeFilter === 'all' ? 'All' : typeFilter === 'credit' ? 'Sent' : 'Taken out'}`,
        `Destination: ${destinationFilter === 'all' ? 'All' : destinationFilter === 'operational_wallet' ? 'Operational float' : 'User wallet'}`,
        `Category: ${categoryFilter.trim() || 'All'}`,
      ];
      doc.text(`Filters — ${appliedFilters.join('  ·  ')}`, marginX, 26.5);

      // Summary band
      doc.setFillColor(248, 246, 252);
      doc.roundedRect(marginX, 30, pageWidth - marginX * 2, 9, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(40, 20, 70);
      doc.text(
        `Total payouts: ${exportRows.length}      Total amount: UGX ${totalAmount.toLocaleString('en-UG')}`,
        marginX + 4,
        36,
      );

      // Divider
      doc.setDrawColor(108, 33, 196);
      doc.setLineWidth(0.6);
      doc.line(marginX, 42, pageWidth - marginX, 42);
      doc.setTextColor(0);

      autoTable(doc, {
        startY: 46,
        margin: { left: marginX, right: marginX, bottom: 16 },
        head: [[
          'Date', 'Recipient', 'Phone', 'Type', 'Destination', 'Category',
          'Amount (UGX)', 'Reference', 'Notes',
        ]],
        body: exportRows.map((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          const recipient = names[r.target_user_id];
          return [
            format(new Date(r.created_at), 'dd/MM/yyyy HH:mm'),
            recipient?.full_name ?? '—',
            recipient?.phone ?? '',
            r.operation === 'credit' ? 'Sent' : 'Taken out',
            meta.recipient_type === 'operational_wallet' ? 'Operational float' : 'User wallet',
            (meta.category_label as string) ?? '',
            Number(r.amount || 0).toLocaleString('en-UG'),
            r.reference_id ?? '',
            (r.evidence ?? '').slice(0, 120),
          ];
        }),
        foot: [[
          '', '', '', '', '', 'TOTAL',
          totalAmount.toLocaleString('en-UG'), '', '',
        ]],
        // Headers repeat automatically on every page.
        showHead: 'everyPage',
        showFoot: 'lastPage',
        rowPageBreak: 'avoid',
        styles: {
          font: 'helvetica',
          fontSize: 8,
          cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
          overflow: 'linebreak',
          valign: 'middle',
          lineColor: [226, 220, 238],
          lineWidth: 0.1,
        },
        headStyles: { fillColor: [108, 33, 196], textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
        footStyles: { fillColor: [243, 238, 252], textColor: [40, 20, 70], fontStyle: 'bold' },
        columnStyles: {
          0: { cellWidth: 26 },
          1: { cellWidth: 42 },
          2: { cellWidth: 26 },
          3: { cellWidth: 18 },
          4: { cellWidth: 30 },
          5: { cellWidth: 34 },
          6: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
          7: { cellWidth: 26 },
          8: { cellWidth: 'auto' },
        },
        alternateRowStyles: { fillColor: [248, 246, 252] },
        didDrawPage: () => {
          const pageNumber = doc.getCurrentPageInfo().pageNumber;
          const pageCount = doc.getNumberOfPages();
          doc.setDrawColor(226, 220, 238);
          doc.setLineWidth(0.3);
          doc.line(marginX, pageHeight - 11, pageWidth - marginX, pageHeight - 11);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(120);
          doc.text('Welile — Confidential financial report', marginX, pageHeight - 7);
          doc.text(
            `Page ${pageNumber} of ${pageCount}`,
            pageWidth - marginX,
            pageHeight - 7,
            { align: 'right' },
          );
          doc.setTextColor(0);
        },
      });

      const filename = `welile-payouts-${iso(window.from)}-to-${iso(window.to)}.pdf`;
      doc.save(filename);
      toast.success(`Exported ${allRows.length} payouts to PDF`);

      // Bulk export of every payout in the window -- names, phones, amounts
      // -- not logged before this. Plain client-side insert so the
      // audit_logs IP-capture trigger sees the real browser IP directly.
      // Never blocks the actual download.
      (async () => {
        try {
          const { data: { user: actor } } = await supabase.auth.getUser();
          await supabase.from('audit_logs').insert({
            user_id: actor?.id ?? null,
            action_type: 'pdf_report_exported',
            table_name: 'export',
            record_id: null,
            metadata: { filename, row_count: allRows.length, total_amount: totalAmount },
          });
        } catch (e) {
          console.warn('[GeneralPayoutActivities] audit log insert failed:', e);
        }
      })();
    } catch (err: any) {
      toast.error('Could not export payouts', { description: err?.message });
    } finally {
      setDownloading(false);
    }
  };

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [
      'cfo-general-payout-activities',
      page,
      periodKind,
      window.from.toISOString(),
      window.to.toISOString(),
      nameFilter.trim(),
      categoryFilter.trim(),
      typeFilter,
      destinationFilter,
    ],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const fromOffset = (page - 1) * PAGE_SIZE;

      let profileIds: string[] | null = null;
      if (nameFilter.trim()) {
        const { data: profiles, error: profileErr } = await supabase
          .from('profiles')
          .select('id')
          .ilike('full_name', `%${nameFilter.trim()}%`)
          .limit(1000);
        if (profileErr) throw profileErr;
        profileIds = (profiles ?? []).map((p: any) => p.id);
        if (profileIds.length === 0) {
          return { rows: [], total: 0, totalAmount: 0 };
        }
      }

      let query = supabase
        .from('platform_wallet_corrections')
        .select('id, operation, amount, evidence, reference_id, created_at, target_user_id, metadata', {
          count: 'exact',
        })
        .gte('created_at', window.from.toISOString())
        .lte('created_at', window.to.toISOString());

      if (profileIds) {
        query = query.in('target_user_id', profileIds);
      }

      if (categoryFilter.trim()) {
        const term = `%${categoryFilter.trim()}%`;
        query = query.or(`metadata->>category_label.ilike.${term},evidence.ilike.${term}`);
      }

      if (typeFilter !== 'all') {
        query = query.eq('operation', typeFilter);
      }

      if (destinationFilter !== 'all') {
        query = query.eq('metadata->>recipient_type', destinationFilter);
      }

      const { data: rows, error: rowsErr, count } = await query
        .order('created_at', { ascending: false })
        .range(fromOffset, fromOffset + PAGE_SIZE - 1);
      if (rowsErr) throw rowsErr;

      const list = (rows ?? []) as unknown as PayoutRow[];
      const ids = Array.from(new Set(list.map((r) => r.target_user_id).filter(Boolean)));
      let names: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        names = Object.fromEntries(
          (profiles ?? []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]),
        );
      }

      // Total amount for the same filtered window, irrespective of pagination.
      let sumQuery = supabase
        .from('platform_wallet_corrections')
        .select('amount', { count: 'exact' })
        .gte('created_at', window.from.toISOString())
        .lte('created_at', window.to.toISOString());

      if (profileIds) sumQuery = sumQuery.in('target_user_id', profileIds);
      if (categoryFilter.trim()) {
        const term = `%${categoryFilter.trim()}%`;
        sumQuery = sumQuery.or(`metadata->>category_label.ilike.${term},evidence.ilike.${term}`);
      }
      if (typeFilter !== 'all') sumQuery = sumQuery.eq('operation', typeFilter);
      if (destinationFilter !== 'all') sumQuery = sumQuery.eq('metadata->>recipient_type', destinationFilter);

      const { data: sumRows, error: sumErr, count: totalCount } = await sumQuery;
      if (sumErr) throw sumErr;

      const totalAmount = (sumRows ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);

      return {
        rows: list.map((r) => ({ ...r, recipient: names[r.target_user_id] ?? null })),
        total: totalCount ?? 0,
        totalAmount,
      };
    },
  });

  const resetFilters = () => {
    setNameFilter('');
    setCategoryFilter('');
    setTypeFilter('credit');
    setDestinationFilter('all');
    setPage(1);
  };

  const navigate = (delta: number) => {
    setPage(1);
    setAnchor((prev) => {
      if (periodKind === 'weekly') return addWeeks(prev, delta);
      if (periodKind === 'monthly') return addMonths(prev, delta);
      if (periodKind === 'quarterly') return addQuarters(prev, delta);
      return prev;
    });
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm" aria-label="General Payout Activities">
      <div className="border-b border-border px-5 py-6 sm:px-7 sm:py-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Banknote className="h-4 w-4" /></span>
              <h2 className="text-xl font-semibold text-foreground sm:text-2xl">General Payout Activities</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">Payout transactions from the platform · {window.label}</p>
          </div>
          <Button variant="outline" size="sm" className="h-9 shrink-0 gap-2 self-start text-xs" onClick={handleDownload} disabled={downloading}>
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {downloading ? 'Preparing…' : 'Download Payout (PDF)'}
          </Button>
        </div>
        <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-border pt-5">
          <div className="flex min-w-[130px] flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Reporting period</Label>
            <Select value={periodKind} onValueChange={(v) => { setPeriodKind(v as PeriodKind); setPage(1); if (v === 'daily') setDailyDate(new Date()); }}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{PERIOD_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {periodKind === 'daily' && <div className="flex flex-col gap-1.5"><Label className="text-xs font-medium text-muted-foreground">Date</Label><DatePickerButton value={dailyDate} onChange={(d) => { if (d) { setDailyDate(d); setAnchor(d); setPage(1); } }} placeholder="Pick a date" /></div>}
          {periodKind === 'custom' && <>
            <div className="flex flex-col gap-1.5"><Label className="text-xs font-medium text-muted-foreground">From date</Label><DatePickerButton value={customFrom} onChange={(d) => { setCustomFrom(d); setPage(1); }} placeholder="Start date" /></div>
            <div className="flex flex-col gap-1.5"><Label className="text-xs font-medium text-muted-foreground">To date</Label><DatePickerButton value={customTo} onChange={(d) => { setCustomTo(d); setPage(1); }} placeholder="End date" /></div>
          </>}
          {(periodKind === 'weekly' || periodKind === 'monthly' || periodKind === 'quarterly') && <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Previous period" onClick={() => navigate(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="min-w-[145px] text-center text-xs font-medium text-foreground">{window.label}</span>
            <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Next period" onClick={() => navigate(1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>}
          <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={() => { const today = new Date(); setAnchor(today); setDailyDate(today); setCustomFrom(undefined); setCustomTo(undefined); setPage(1); }}>Today</Button>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-4 sm:p-5">
            <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">Total payout amount</p><p className="mt-1 break-words text-xl font-semibold text-foreground sm:text-2xl">{formatUGX(data?.totalAmount ?? 0)}</p></div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Wallet className="h-5 w-5" /></span>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-4 sm:p-5">
            <div><p className="text-xs font-medium text-muted-foreground">Number of payouts</p><p className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">{data?.total ?? 0}</p></div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"><History className="h-5 w-5" /></span>
          </div>
        </div>
      </div>

      <div className="border-b border-border bg-muted/20 px-5 py-5 sm:px-7">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div><h3 className="text-sm font-semibold text-foreground">Payout records</h3><p className="text-xs text-muted-foreground">{window.label}{isFetching && !isLoading ? ' · Updating…' : ''}</p></div>
          {hasFilters && <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1 text-xs" onClick={resetFilters}><X className="h-3.5 w-3.5" />Clear filters</Button>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-1.5"><Label htmlFor="gp-filter-name" className="text-xs text-muted-foreground">Recipient name</Label><Input id="gp-filter-name" placeholder="Search name…" value={nameFilter} onChange={(e) => { setNameFilter(e.target.value); setPage(1); }} className="h-9 bg-card text-xs" /></div>
          <div className="min-w-0 space-y-1.5"><Label htmlFor="gp-filter-category" className="text-xs text-muted-foreground">Category</Label><Input id="gp-filter-category" placeholder="Search category…" value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }} className="h-9 bg-card text-xs" /></div>
          <div className="min-w-0 space-y-1.5"><Label className="text-xs text-muted-foreground">Type</Label><Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v as TypeFilter); setPage(1); }}><SelectTrigger className="h-9 bg-card text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All types</SelectItem><SelectItem value="credit">Sent</SelectItem><SelectItem value="debit">Taken out</SelectItem></SelectContent></Select></div>
          <div className="min-w-0 space-y-1.5"><Label className="text-xs text-muted-foreground">Destination</Label><Select value={destinationFilter} onValueChange={(v) => { setDestinationFilter(v as DestinationFilter); setPage(1); }}><SelectTrigger className="h-9 bg-card text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All destinations</SelectItem><SelectItem value="user">User wallet</SelectItem><SelectItem value="operational_wallet">Operational float</SelectItem></SelectContent></Select></div>
        </div>
      </div>

      {isLoading ? <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : error ? <p className="px-7 py-8 text-sm text-destructive">Could not load payout activity.</p> : !data || data.rows.length === 0 ? <p className="px-7 py-8 text-sm text-muted-foreground">{hasFilters ? 'No payouts match the selected filters.' : 'No payouts recorded for this period.'}</p> : <>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-xs sm:text-sm">
            <thead className="bg-muted/30"><tr className="border-b border-border text-muted-foreground">
              <th className="px-5 py-3 font-medium sm:pl-7">Reference</th><th className="px-4 py-3 font-medium">Recipient</th><th className="px-4 py-3 font-medium">Date &amp; time</th><th className="px-4 py-3 font-medium">Type</th><th className="px-4 py-3 font-medium">Destination</th><th className="px-4 py-3 font-medium">Category</th><th className="px-5 py-3 text-right font-medium sm:pr-7">Amount</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {data.rows.map((row) => {
                const isDebit = row.operation === 'debit';
                const meta = (row.metadata ?? {}) as Record<string, any>;
                const destination = meta.recipient_type === 'operational_wallet' ? 'Operational float' : 'User wallet';
                return <tr key={row.id} className="transition-colors hover:bg-muted/20">
                  <td className="max-w-[150px] break-all px-5 py-4 font-mono text-xs text-muted-foreground sm:pl-7">{row.reference_id || '—'}</td>
                  <td className="px-4 py-4"><div className="font-semibold text-foreground">{row.recipient?.full_name || 'Unknown'}</div><div className="text-xs text-muted-foreground">{row.recipient?.phone || '—'}</div></td>
                  <td className="whitespace-nowrap px-4 py-4 text-muted-foreground">{format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}</td>
                  <td className="px-4 py-4"><Badge variant={isDebit ? 'destructive' : 'secondary'} className="gap-1 text-xs">{isDebit ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}{isDebit ? 'Taken out' : 'Sent'}</Badge></td>
                  <td className="px-4 py-4 text-muted-foreground">{destination}</td>
                  <td className="max-w-[180px] px-4 py-4 text-muted-foreground" title={String(meta.category_label || row.evidence || '')}><span className="block truncate">{meta.category_label || row.evidence || '—'}</span></td>
                  <td className={cn('whitespace-nowrap px-5 py-4 text-right font-semibold sm:pr-7', isDebit ? 'text-destructive' : 'text-foreground')}>{isDebit ? '−' : '+'}{formatUGX(Number(row.amount))}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <p className="text-xs text-muted-foreground">Showing <span className="font-medium text-foreground">{rangeStart}–{rangeEnd}</span> of <span className="font-medium text-foreground">{total}</span> payouts</p>
          <nav aria-label="Payout pages" className="flex flex-wrap items-center gap-1">
            <Button variant="outline" size="sm" className="h-8 gap-1 px-2 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-4 w-4" />Previous</Button>
            {pageWindow(page, totalPages).map((p, i) => p === 'gap' ? <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">…</span> : <Button key={p} variant={p === page ? 'default' : 'outline'} size="sm" aria-label={`Page ${p}`} aria-current={p === page ? 'page' : undefined} className="h-8 w-8 p-0 text-xs" onClick={() => setPage(p)}>{p}</Button>)}
            <Button variant="outline" size="sm" className="h-8 gap-1 px-2 text-xs" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next<ChevronRight className="h-4 w-4" /></Button>
          </nav>
        </div>
      </>}
    </section>
  );
}
