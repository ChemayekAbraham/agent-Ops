import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Ban, ChevronLeft, ChevronRight, Copy, Download, ExternalLink,
  FileSpreadsheet, FilePlus2, Loader2, Receipt, Search, User, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useReceiptAccess } from '@/hooks/usePartnerReceipts';
import {
  ARCHIVE_PAGE_SIZE, PAYOUT_RECEIPT_BASE_URL, fetchPartnerReceiptRow, resolveRange, useClientCard, useReceiptArchive, useReceiptArchiveSummary,
  type ArchiveDirection, type ClientCardData, type ArchiveFilters, type ArchiveRange, type ArchiveRow, type ArchiveSource, type ArchiveStatus,
} from '@/hooks/useReceiptArchive';
import { downloadPartnerReceiptPdf } from '@/lib/partnerReceiptPdf';
import { formatUGX } from '@/lib/rentCalculations';
import { finopsPath } from '@/lib/financialOpsRoutes';
import { cn } from '@/lib/utils';

const PayoutProofsPanel = lazy(() => import('@/components/shared/ReceiptArchivePanel'));

/**
 * Receipt Archive home: every receipt Welile has issued, money in and money out, in one searchable list.
 * Read-only. A receipt is evidence of money that already went through the system; nothing here moves money.
 * Searching by a client's phone number (any format) finds their receipts across all dates.
 */

const ANY = '__any';
const METHODS: Record<string, string> = {
  cash: 'Cash', cheque: 'Cheque', bank_draft: 'Bank draft', bank_transfer: 'Bank transfer', mobile_money: 'Mobile money',
};
const SOURCES: Record<ArchiveSource, string> = { partner_receipt: 'Partner receipt', payout: 'Payout' };
const STATUSES: Record<ArchiveStatus, string> = { issued: 'Issued', voided: 'Voided', corrected: 'Corrected' };
const RANGES: { id: ArchiveRange; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'week', label: 'This week' }, { id: 'custom', label: 'Custom' },
];
const RANGE_LABEL: Record<ArchiveRange, string> = { today: 'Today', yesterday: 'Yesterday', week: 'This week', custom: 'Custom range' };

/** 0772123456 -> 0772 123 456. Anything that is not a 10-digit local number is shown as it was stored. */
function prettyPhone(p: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  const local = d.startsWith('256') && d.length === 12 ? `0${d.slice(3)}` : d;
  return local.length === 10 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : p;
}

function readFilters(sp: URLSearchParams): ArchiveFilters {
  const range = sp.get('range') as ArchiveRange | null;
  const dir = sp.get('dir');
  return {
    search: sp.get('q') ?? '',
    direction: dir === 'in' || dir === 'out' ? dir : '',
    range: range && RANGES.some((r) => r.id === range) ? range : 'week',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    method: sp.get('method') ?? '',
    source: (sp.get('source') as ArchiveSource | null) ?? '',
    status: (sp.get('status') as ArchiveStatus | null) ?? '',
    page: Math.max(0, Number(sp.get('page') ?? 0) || 0),
  };
}

export function ReceiptArchiveHome() {
  const { toast } = useToast();
  const [sp, setSp] = useSearchParams();
  const f = readFilters(sp);
  const access = useReceiptAccess();
  const list = useReceiptArchive(f);
  const summary = useReceiptArchiveSummary(f);
  const client = useClientCard(f.search);
  const [typed, setTyped] = useState(f.search);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Change filters in the URL, keeping every other query param (the page may carry its own). */
  const set = (patch: Partial<Record<'q' | 'dir' | 'range' | 'from' | 'to' | 'method' | 'source' | 'status' | 'page', string>>, keepPage = false) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      if (!keepPage && !('page' in patch)) next.delete('page');
      return next;
    }, { replace: true });

  // Debounce the search box into the URL.
  useEffect(() => {
    if (typed === f.search) return;
    const t = setTimeout(() => set({ q: typed.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);
  useEffect(() => { setTyped(f.search); }, [f.search]);

  const rows = list.data ?? [];
  const total = rows[0]?.total_count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
  const searching = f.search.trim() !== '';
  const s = summary.data;
  const filtersActive = !!(f.search || f.direction || f.method || f.source || f.status || f.range !== 'week');
  const canIssue = !!access.data?.canIssue;
  const seesPayouts = s?.can_see_payouts !== false;

  const clearAll = () => {
    setTyped('');
    setSp((prev) => { const n = new URLSearchParams(); const tool = prev.get('tool'); if (tool) n.set('tool', tool); return n; }, { replace: true });
  };

  const fail = (e: unknown) => toast({ title: 'Could not do that', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });

  const downloadPdf = async (r: ArchiveRow) => {
    if (r.receipt_no == null) return;
    setBusyId(r.id);
    try { await downloadPartnerReceiptPdf(await fetchPartnerReceiptRow(r.receipt_no, r.id)); } catch (e) { fail(e); } finally { setBusyId(null); }
  };
  const copyLink = async (token: string) => {
    const url = `${PAYOUT_RECEIPT_BASE_URL}${token}`;
    try { await navigator.clipboard.writeText(url); toast({ title: 'Receipt link copied', description: url }); } catch { toast({ title: 'Copy failed', description: url, variant: 'destructive' }); }
  };

  const exportExcel = async () => {
    const XLSX = await import('xlsx');
    const sheet = rows.map((r) => ({
      'Receipt': r.receipt_ref, 'Date': format(new Date(r.event_at), 'yyyy-MM-dd'), 'Direction': r.direction === 'in' ? 'Money in' : 'Money out',
      'Client': r.client_name ?? '', 'Phone': r.client_phone ?? '', 'Purpose': r.purpose, 'Method': METHODS[r.method] ?? r.method,
      'Amount (UGX)': r.amount, 'Status': STATUSES[r.status], 'Replaced by': r.replaced_by_no ?? '', 'Issued by': r.issued_by_name ?? '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'Receipts');
    XLSX.writeFile(wb, `welile-receipt-archive-${format(new Date(), 'yyyy-MM-dd')}.xlsx`);
  };

  const rangeText = RANGE_LABEL[f.range];
  const r = resolveRange(f);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="h-11 w-11 rounded-xl border flex items-center justify-center bg-primary/10 text-primary">
            <Receipt className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight">Receipt Archive</h1>
            <p className="text-sm text-muted-foreground">Every receipt Welile has issued, money in and money out.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={!rows.length}>
            <FileSpreadsheet className="h-4 w-4 mr-1" /> Export
          </Button>
          {canIssue && (
            <Button size="sm" asChild>
              <Link to={finopsPath('partner_receipts')}><FilePlus2 className="h-4 w-4 mr-1" /> Issue receipt</Link>
            </Button>
          )}
        </div>
      </header>

      <Tabs defaultValue="receipts">
        <TabsList>
          <TabsTrigger value="receipts">Receipts{list.data ? ` (${total.toLocaleString()})` : ''}</TabsTrigger>
          {seesPayouts && <TabsTrigger value="proofs">Payout proofs</TabsTrigger>}
        </TabsList>

        <TabsContent value="receipts" className="space-y-4 mt-4">
          {/* Summary cards follow the date range. They also act as quick filters. */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">
              {rangeText}{f.range === 'custom' && r.from ? ` · ${r.from}${r.to && r.to !== r.from ? ` to ${r.to}` : ''}` : ''}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <SummaryCard label="Receipts issued" value={s ? String(s.issued_count) : null} onClick={() => set({ dir: '', status: '' })} />
              <SummaryCard label="Money in" value={s ? formatUGX(s.in_total) : null} tone="in" active={f.direction === 'in'} onClick={() => set({ dir: 'in' })} />
              {seesPayouts && (
                <SummaryCard label="Money out" value={s ? formatUGX(s.out_total) : null} tone="out" active={f.direction === 'out'} onClick={() => set({ dir: 'out' })} />
              )}
              <SummaryCard
                label="Pending" value={s ? String(s.pending_count) : null} tone="warn"
                hint={s ? 'needs action' : undefined} href={finopsPath('partner_receipts')}
              />
              <SummaryCard label="Voided" value={s ? String(s.voided_count) : null} active={f.status === 'voided'} onClick={() => set({ status: 'voided' })} />
            </div>
          </div>

          {/* Direction */}
          <div className="inline-flex rounded-lg border p-0.5 bg-muted/40" role="group" aria-label="Direction">
            {([['', 'All'], ['in', 'In (money in)'], ['out', 'Out (money out)']] as [ArchiveDirection | '', string][])
              .filter(([v]) => v !== 'out' || seesPayouts)
              .map(([v, label]) => (
                <button
                  key={v || 'all'} type="button" onClick={() => set({ dir: v })} aria-pressed={f.direction === v}
                  className={cn('px-3 py-1.5 text-sm rounded-md transition-colors', f.direction === v ? 'bg-primary text-primary-foreground font-semibold' : 'text-muted-foreground hover:text-foreground')}
                >{label}</button>
              ))}
          </div>

          {/* Search + date range */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[260px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                value={typed} onChange={(e) => setTyped(e.target.value)}
                placeholder="Search by client phone number, name, or receipt number"
                className="pl-9 pr-9" aria-label="Search receipts"
              />
              {typed && (
                <button type="button" aria-label="Clear search" onClick={() => setTyped('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md hover:bg-muted flex items-center justify-center">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="inline-flex rounded-lg border p-0.5 bg-muted/40" role="group" aria-label="Date range">
              {RANGES.map((x) => (
                <button key={x.id} type="button" onClick={() => set({ range: x.id === 'week' ? '' : x.id })} aria-pressed={f.range === x.id}
                  className={cn('px-3 py-1.5 text-sm rounded-md transition-colors', f.range === x.id ? 'bg-background shadow-sm font-semibold' : 'text-muted-foreground hover:text-foreground')}
                >{x.label}</button>
              ))}
            </div>
            {f.range === 'custom' && (
              <div className="flex items-center gap-1">
                <Input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} className="w-[140px]" aria-label="From date" />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} className="w-[140px]" aria-label="To date" />
              </div>
            )}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect label="Method" value={f.method} options={METHODS} onChange={(v) => set({ method: v })} />
            {seesPayouts && <FilterSelect label="Source" value={f.source} options={SOURCES} onChange={(v) => set({ source: v })} />}
            <FilterSelect label="Status" value={f.status} options={STATUSES} onChange={(v) => set({ status: v })} />
            {filtersActive && <Button variant="ghost" size="sm" className="text-primary" onClick={clearAll}>Clear filters</Button>}
            {searching && <span className="text-xs text-muted-foreground">Searching all dates</span>}
          </div>

          {/* Client behind a phone-number search */}
          {client.isLoading && <Skeleton className="h-28 w-full rounded-xl" />}
          {client.data && <ClientCard data={client.data} />}

          {/* Table */}
          {list.isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive flex items-start gap-2" role="alert">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Could not load receipts.</div>
                <div className="text-destructive/80">{list.error instanceof Error ? list.error.message : 'Unknown error'}</div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full text-sm min-w-[980px]">
                <thead className="bg-muted/40 border-b">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">No.</th>
                    <th className="px-3 py-2 font-semibold">Date</th>
                    <th className="px-3 py-2 font-semibold">Direction</th>
                    <th className="px-3 py-2 font-semibold">Client</th>
                    <th className="px-3 py-2 font-semibold">Phone</th>
                    <th className="px-3 py-2 font-semibold">Purpose</th>
                    <th className="px-3 py-2 font-semibold">Method</th>
                    <th className="px-3 py-2 font-semibold text-right">Amount</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {list.isLoading ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i}>{Array.from({ length: 10 }).map((__, j) => <td key={j} className="px-3 py-3"><Skeleton className="h-4 w-full" /></td>)}</tr>
                    ))
                  ) : rows.length === 0 ? (
                    <tr><td colSpan={10} className="px-3 py-14 text-center">
                      <Receipt className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" aria-hidden="true" />
                      <div className="font-semibold">No receipts match this search</div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {searching ? 'Try the last digits of the phone number.' : 'Try a wider date range, or clear the filters.'}
                      </div>
                    </td></tr>
                  ) : rows.map((row) => (
                    <ArchiveTableRow key={`${row.source}-${row.id}`} row={row} busy={busyId === row.id} onPdf={downloadPdf} onCopy={copyLink} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                Showing {f.page * ARCHIVE_PAGE_SIZE + 1}–{Math.min((f.page + 1) * ARCHIVE_PAGE_SIZE, total)} of {total.toLocaleString()}
                {list.isFetching && <Loader2 className="inline h-3.5 w-3.5 ml-2 animate-spin" aria-label="Loading" />}
              </span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" disabled={f.page === 0} onClick={() => set({ page: String(f.page - 1 || '') }, true)} aria-label="Previous page">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-2 tabular-nums">Page {f.page + 1} of {totalPages}</span>
                <Button size="sm" variant="outline" disabled={f.page >= totalPages - 1} onClick={() => set({ page: String(f.page + 1) }, true)} aria-label="Next page">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Digital receipts start at No. 4300. Paper receipts up to No. 4299 are not in this list, and carry no phone number.
          </p>
        </TabsContent>

        {seesPayouts && (
          <TabsContent value="proofs" className="mt-4">
            <Suspense fallback={<Loader2 className="h-5 w-5 animate-spin" />}><PayoutProofsPanel /></Suspense>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function ClientCard({ data }: { data: ClientCardData }) {
  // Several different numbers match what was typed: no single client to show, so ask for the full number.
  if (!data.phone) {
    return (
      <div className="rounded-xl border bg-card p-3 text-sm text-muted-foreground" role="status">
        {data.otherNumbers} different phone numbers match. Type the full number to see one client's receipts.
      </div>
    );
  }
  const initial = (data.name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <section className="rounded-xl border bg-card p-4 space-y-3" aria-label="Client summary">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="h-11 w-11 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold" aria-hidden="true">
            {data.name ? initial : <User className="h-5 w-5" />}
          </span>
          <div className="min-w-0">
            <div className="font-bold text-lg leading-tight truncate">{data.name || 'Name not recorded'}</div>
            <div className="text-sm text-muted-foreground tabular-nums">{prettyPhone(data.phone)}</div>
          </div>
        </div>
        <Badge variant="secondary" className="text-xs">
          {data.truncated ? '200+' : data.receipts} receipt{data.receipts === 1 ? '' : 's'}
        </Badge>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">Total in</dt>
          <dd className="text-lg font-black tabular-nums text-emerald-600 dark:text-emerald-400">{formatUGX(data.inTotal)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Total out</dt>
          <dd className="text-lg font-black tabular-nums text-amber-600 dark:text-amber-400">{formatUGX(data.outTotal)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">First receipt</dt>
          <dd className="text-lg font-black tabular-nums">{data.firstAt ? format(new Date(data.firstAt), 'dd MMM yyyy') : '—'}</dd>
        </div>
      </dl>

      {data.names.length > 1 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
          <span>{data.names.length} names used on this number: {data.names.join(', ')}.</span>
        </div>
      )}
      {data.truncated && (
        <p className="text-xs text-muted-foreground">Totals cover the 200 most recent receipts on this number.</p>
      )}
      <p className="text-xs text-muted-foreground">Totals count issued receipts only. Paper receipts before No. 4300 don't have phone numbers recorded.</p>
    </section>
  );
}

function SummaryCard({ label, value, tone, hint, active, onClick, href }: {
  label: string; value: string | null; tone?: 'in' | 'out' | 'warn'; hint?: string; active?: boolean; onClick?: () => void; href?: string;
}) {
  const body = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      {value === null ? <Skeleton className="h-6 w-20 mt-1" /> : (
        <div className={cn('text-xl font-black tabular-nums mt-0.5',
          tone === 'in' && 'text-emerald-600 dark:text-emerald-400', tone === 'out' && 'text-amber-600 dark:text-amber-400', tone === 'warn' && 'text-amber-600 dark:text-amber-400')}>
          {value}
        </div>
      )}
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </>
  );
  const cls = cn('rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'border-primary ring-1 ring-primary');
  if (href) return <Link to={href} className={cls}>{body}</Link>;
  return <button type="button" onClick={onClick} className={cls} aria-pressed={active}>{body}</button>;
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: Record<string, string>; onChange: (v: string) => void }) {
  return (
    <Select value={value || ANY} onValueChange={(v) => onChange(v === ANY ? '' : v)}>
      <SelectTrigger className="h-9 w-auto min-w-[130px] gap-2" aria-label={label}><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{label}: any</SelectItem>
        {Object.entries(options).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function ArchiveTableRow({ row, busy, onPdf, onCopy }: { row: ArchiveRow; busy: boolean; onPdf: (r: ArchiveRow) => void; onCopy: (token: string) => void }) {
  const isIn = row.direction === 'in';
  const at = new Date(row.event_at);
  const dead = row.status !== 'issued';
  return (
    <tr className="hover:bg-muted/30 transition-colors">
      <td className="px-3 py-2 font-mono text-xs font-semibold whitespace-nowrap">{row.receipt_ref}</td>
      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
        {format(at, 'dd MMM yyyy')}
        {!isIn && <div className="text-[11px] text-muted-foreground">{format(at, 'HH:mm')}</div>}
      </td>
      <td className="px-3 py-2">
        <Badge variant="outline" className={cn('gap-1 text-[10px] font-bold', isIn ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400' : 'border-amber-500/40 text-amber-700 dark:text-amber-400')}>
          {isIn ? <ArrowDownLeft className="h-3 w-3" aria-hidden="true" /> : <ArrowUpRight className="h-3 w-3" aria-hidden="true" />}
          {isIn ? 'IN' : 'OUT'}
        </Badge>
      </td>
      <td className="px-3 py-2 font-medium max-w-[180px] truncate" title={row.client_name ?? ''}>{row.client_name || '—'}</td>
      <td className="px-3 py-2 tabular-nums whitespace-nowrap">{prettyPhone(row.client_phone) || <span className="text-muted-foreground">—</span>}</td>
      <td className="px-3 py-2 max-w-[170px] truncate" title={row.purpose}>{row.purpose}</td>
      <td className="px-3 py-2 whitespace-nowrap">{METHODS[row.method] ?? row.method}</td>
      <td className={cn('px-3 py-2 text-right font-bold tabular-nums whitespace-nowrap', dead && 'line-through text-muted-foreground')}>{formatUGX(row.amount)}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <Badge variant="outline" className={cn('text-[10px] font-semibold',
          row.status === 'issued' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
          row.status === 'voided' && 'border-border bg-muted text-muted-foreground',
          row.status === 'corrected' && 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
          {row.status === 'voided' && <Ban className="h-3 w-3 mr-1" aria-hidden="true" />}{STATUSES[row.status]}
        </Badge>
        {row.status === 'corrected' && row.replaced_by_no != null && <div className="text-[11px] text-muted-foreground">see {row.replaced_by_no}</div>}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1">
          {row.source === 'partner_receipt' && (
            <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => onPdf(row)} disabled={busy} title="Download PDF" aria-label={`Download PDF for receipt ${row.receipt_ref}`}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </Button>
          )}
          {row.source === 'payout' && row.link_token && (
            <>
              <Button size="sm" variant="ghost" className="h-8 px-2" asChild title="Open receipt page">
                <a href={`${PAYOUT_RECEIPT_BASE_URL}${row.link_token}`} target="_blank" rel="noopener noreferrer" aria-label={`Open receipt ${row.receipt_ref}`}><ExternalLink className="h-4 w-4" /></a>
              </Button>
              <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => onCopy(row.link_token!)} title="Copy public link" aria-label={`Copy link for receipt ${row.receipt_ref}`}>
                <Copy className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

export default ReceiptArchiveHome;
