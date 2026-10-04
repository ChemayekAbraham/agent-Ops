import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { cn } from '@/lib/utils';
import {
  Search, Pencil, History, Loader2, Save, X, UserPlus, Users, ChevronRight,
  List, CalendarDays, Filter, CalendarIcon, ArrowUpDown, Clock, User,
  Download, FileText,
} from 'lucide-react';

interface TenantRentRow {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  landlord_name: string | null;
  status: string | null;
  rent_amount: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  daily_repayment: number | null;
  outstanding: number | null;
  created_at: string;
}

interface BalanceEditRow {
  id: string;
  editor_name: string | null;
  old_rent_amount: number | null;
  new_rent_amount: number | null;
  old_outstanding: number | null;
  new_outstanding: number | null;
  old_daily_repayment: number | null;
  new_daily_repayment: number | null;
  reason: string;
  created_at: string;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function TenantBalanceEditPanel({
  onOpenAgent,
}: {
  onOpenAgent?: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const term = search.trim();
  const [editing, setEditing] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const { data, isLoading, isFetching } = useQuery({
    enabled: term.length >= 2,
    queryKey: ['ops-tenant-rents', term],
    staleTime: 15_000,
    queryFn: async (): Promise<TenantRentRow[]> => {
      const { data, error } = await supabase.rpc('ops_search_tenant_rents' as any, { p_search: term });
      if (error) throw error;
      return (data ?? []) as TenantRentRow[];
    },
  });

  const rows = data ?? [];

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search any tenant by name, phone or national ID…"
          className="pl-7 h-9 text-sm"
        />
        {isFetching && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      <ScrollArea className="max-h-[55vh] pr-1">
        {term.length < 2 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Type at least 2 characters to find a tenant.</p>
        ) : isLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No tenants match your search.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.rent_request_id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                  <span className="font-semibold text-sm truncate flex-1">{r.tenant_name || 'Tenant'}</span>
                  {r.status && <Badge variant="outline" className="text-[10px] shrink-0">{r.status}</Badge>}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
                  {r.tenant_phone && <span>{r.tenant_phone}</span>}
                  {r.landlord_name && <span>Landlord: {r.landlord_name}</span>}
                  {r.agent_id && (
                    <button
                      onClick={() => onOpenAgent?.(r.agent_id!)}
                      className="flex items-center gap-0.5 text-blue-600 hover:underline"
                    >
                      <UserPlus className="h-3 w-3" /> {r.agent_name || 'Agent'}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 mt-2 text-center">
                  <div className="rounded-md bg-muted/50 py-1">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Rent</p>
                    <p className="text-xs font-bold">{formatUGX(r.rent_amount || 0)}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 py-1">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Balance</p>
                    <p className="text-xs font-bold text-amber-600">{formatUGX(r.outstanding || 0)}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 py-1">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Daily</p>
                    <p className="text-xs font-bold">{formatUGX(r.daily_repayment || 0)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-2">
                  <Button
                    size="sm" variant="outline"
                    className="h-7 text-[11px] gap-1 flex-1"
                    onClick={() => { setEditing(editing === r.rent_request_id ? null : r.rent_request_id); setHistoryFor(null); }}
                  >
                    <Pencil className="h-3 w-3" /> {editing === r.rent_request_id ? 'Close' : 'Edit balance / rent'}
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className="h-7 text-[11px] gap-1"
                    onClick={() => { setHistoryFor(historyFor === r.rent_request_id ? null : r.rent_request_id); setEditing(null); }}
                  >
                    <History className="h-3 w-3" /> History
                  </Button>
                </div>

                {editing === r.rent_request_id && (
                  <BalanceEditForm row={r} onDone={() => setEditing(null)} />
                )}
                {historyFor === r.rent_request_id && (
                  <BalanceHistory rentRequestId={r.rent_request_id} tenantName={r.tenant_name} />
                )}
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function BalanceEditForm({ row, onDone }: { row: TenantRentRow; onDone: () => void }) {
  const qc = useQueryClient();
  const [rent, setRent] = useState(String(row.rent_amount ?? ''));
  const [outstanding, setOutstanding] = useState(String(row.outstanding ?? ''));
  const [reason, setReason] = useState('');

  const rentChanged = rent !== '' && Number(rent) !== Number(row.rent_amount ?? 0);
  const balChanged = outstanding !== '' && Number(outstanding) !== Number(row.outstanding ?? 0);

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('ops_edit_tenant_balance' as any, {
        p_rent_request_id: row.rent_request_id,
        p_new_rent_amount: rentChanged ? Number(rent) : null,
        p_new_outstanding: balChanged ? Number(outstanding) : null,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Sent to the CFO for approval', {
        description: "Nothing changes on this tenant's plan until the CFO approves it.",
      });
      qc.invalidateQueries({ queryKey: ['ops-tenant-rents'] });
      qc.invalidateQueries({ queryKey: ['ops-balance-history', row.rent_request_id] });
      qc.invalidateQueries({ queryKey: ['welile-mission-placements'] });
      qc.invalidateQueries({ queryKey: ['agent-capacity-map'] });
      qc.invalidateQueries({ queryKey: ['agent-daily-eligibility'] });
      onDone();
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to update balance'),
  });

  const canSave = (rentChanged || balChanged) && reason.trim().length >= 20 && !mutation.isPending;

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Rent amount (UGX)</label>
          <Input type="number" inputMode="numeric" value={rent} onChange={(e) => setRent(e.target.value)} className="h-9 text-sm mt-0.5" />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Outstanding balance (UGX)</label>
          <Input type="number" inputMode="numeric" value={outstanding} onChange={(e) => setOutstanding(e.target.value)} className="h-9 text-sm mt-0.5" />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        This is a request, not a change. The CFO must approve it before the tenant's plan moves. Changing the rent amount recalculates the daily repayment and the agent's daily target; setting the balance to 0 removes this tenant from that target.
      </p>
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Reason for the CFO (required, min 20 chars)</label>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain the correction — the CFO reads this before approving."
          className="text-sm mt-0.5 min-h-[60px]"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-8 text-xs gap-1 flex-1" disabled={!canSave} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Send for CFO approval
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs gap-1" onClick={onDone} disabled={mutation.isPending}>
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
      </div>
    </div>
  );
}

function escapeCsvCell(val: string | number | null): string {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows: BalanceEditRow[]): string {
  const headers = ['Date', 'Editor', 'Old Rent', 'New Rent', 'Old Balance', 'New Balance', 'Old Daily', 'New Daily', 'Reason'];
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.created_at,
      r.editor_name ?? '',
      r.old_rent_amount ?? '',
      r.new_rent_amount ?? '',
      r.old_outstanding ?? '',
      r.new_outstanding ?? '',
      r.old_daily_repayment ?? '',
      r.new_daily_repayment ?? '',
      r.reason,
    ].map(escapeCsvCell).join(','));
  }
  return lines.join('\n');
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportHistoryToPdf(rows: BalanceEditRow[], title: string) {
  const [{ jsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableMod as any).default || autoTableMod;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw = pdf.internal.pageSize.getWidth();
  const margin = 14;

  pdf.setFontSize(16);
  pdf.text('Tenant Balance Edit History', margin, 18);
  pdf.setFontSize(10);
  pdf.setTextColor(100);
  pdf.text(title, margin, 24);
  pdf.text(`Exported: ${new Date().toLocaleString()}`, margin, 29);

  const body = rows.map((r) => [
    new Date(r.created_at).toLocaleString(),
    r.editor_name ?? '-',
    formatUGX(r.old_rent_amount || 0),
    formatUGX(r.new_rent_amount || 0),
    formatUGX(r.old_outstanding || 0),
    formatUGX(r.new_outstanding || 0),
    formatUGX(r.old_daily_repayment || 0),
    formatUGX(r.new_daily_repayment || 0),
    r.reason,
  ]);

  autoTable(pdf, {
    startY: 34,
    head: [['Date', 'Editor', 'Old Rent', 'New Rent', 'Old Balance', 'New Balance', 'Old Daily', 'New Daily', 'Reason']],
    body,
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    margin: { left: margin, right: margin },
    tableWidth: pw - margin * 2,
  });

  pdf.save('tenant-balance-history.pdf');
}

function BalanceHistory({ rentRequestId, tenantName }: { rentRequestId: string; tenantName?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ops-balance-history', rentRequestId],
    staleTime: 15_000,
    queryFn: async (): Promise<BalanceEditRow[]> => {
      const { data, error } = await supabase.rpc('ops_tenant_balance_history' as any, { p_rent_request_id: rentRequestId });
      if (error) throw error;
      return (data ?? []) as BalanceEditRow[];
    },
  });

  const [editorFilter, setEditorFilter] = useState<string>('all');
  const [reasonFilter, setReasonFilter] = useState('');
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [showFilters, setShowFilters] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const rows = data ?? [];
  const editors = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.editor_name) set.add(r.editor_name); });
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    let result = [...rows];
    if (editorFilter !== 'all') {
      result = result.filter((r) => r.editor_name === editorFilter);
    }
    if (reasonFilter.trim()) {
      const term = reasonFilter.trim().toLowerCase();
      result = result.filter((r) => r.reason.toLowerCase().includes(term));
    }
    if (dateFrom) {
      const from = new Date(dateFrom); from.setHours(0, 0, 0, 0);
      result = result.filter((r) => new Date(r.created_at) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo); to.setHours(23, 59, 59, 999);
      result = result.filter((r) => new Date(r.created_at) <= to);
    }
    result.sort((a, b) => {
      const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return sortOrder === 'newest' ? -diff : diff;
    });
    return result;
  }, [rows, editorFilter, reasonFilter, dateFrom, dateTo, sortOrder]);

  if (isLoading) return <div className="mt-3"><Skeleton className="h-16 w-full" /></div>;
  if (rows.length === 0) return <p className="mt-3 text-[11px] text-muted-foreground text-center py-2">No edits yet.</p>;

  const dateFmtOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

  const handleExportCsv = () => {
    if (filtered.length === 0) { toast.info('Nothing to export — adjust your filters'); return; }
    const csv = buildCsv(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const name = tenantName ? `${tenantName.replace(/\s+/g, '_')}-balance-history` : 'tenant-balance-history';
    downloadBlob(`${name}.csv`, blob);
    toast.success(`CSV exported (${filtered.length} rows)`);
  };

  const handleExportPdf = async () => {
    if (filtered.length === 0) { toast.info('Nothing to export — adjust your filters'); return; }
    setIsExporting(true);
    try {
      await exportHistoryToPdf(filtered, tenantName || 'Tenant');
      toast.success(`PDF exported (${filtered.length} rows)`);
    } catch (e: any) {
      toast.error(e?.message || 'PDF export failed');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{filtered.length} of {rows.length} edits</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 px-1.5" disabled={isExporting} onClick={handleExportCsv}>
            <Download className="h-3 w-3" /> CSV
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 px-1.5" disabled={isExporting} onClick={handleExportPdf}>
            {isExporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />} PDF
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 px-1.5" onClick={() => setShowFilters((s) => !s)}>
            <Filter className="h-3 w-3" /> {showFilters ? 'Hide' : 'Filter'}
          </Button>
        </div>
      </div>

      {showFilters && (
        <div className="rounded-lg border border-border bg-muted/20 p-2.5 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Editor</label>
              <select
                value={editorFilter}
                onChange={(e) => setEditorFilter(e.target.value)}
                className="mt-0.5 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All editors</option>
                {editors.map((ed) => (
                  <option key={ed} value={ed}>{ed}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Reason keyword</label>
              <Input value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)} placeholder="Search reason…" className="h-8 text-xs mt-0.5" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">From date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="mt-0.5 h-8 w-full justify-start text-left text-xs font-normal px-2">
                    <CalendarIcon className="mr-1.5 h-3 w-3 text-muted-foreground" />
                    {dateFrom ? dateFrom.toLocaleDateString(undefined, dateFmtOpts) : 'Pick date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
                  <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} initialFocus />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <label className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">To date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="mt-0.5 h-8 w-full justify-start text-left text-xs font-normal px-2">
                    <CalendarIcon className="mr-1.5 h-3 w-3 text-muted-foreground" />
                    {dateTo ? dateTo.toLocaleDateString(undefined, dateFmtOpts) : 'Pick date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
                  <Calendar mode="single" selected={dateTo} onSelect={setDateTo} initialFocus />
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 px-1" onClick={() => { setEditorFilter('all'); setReasonFilter(''); setDateFrom(undefined); setDateTo(undefined); }}>
              Clear filters
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 px-1" onClick={() => setSortOrder((s) => s === 'newest' ? 'oldest' : 'newest')}>
              <ArrowUpDown className="h-3 w-3" /> {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
            </Button>
          </div>
        </div>
      )}

      <Tabs defaultValue="list" className="w-full">
        <TabsList variant="pills" className="w-full">
          <TabsTrigger value="list" variant="pills" className="text-[11px] flex-1 gap-1">
            <List className="h-3 w-3" /> List
          </TabsTrigger>
          <TabsTrigger value="timeline" variant="pills" className="text-[11px] flex-1 gap-1">
            <CalendarDays className="h-3 w-3" /> Timeline
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-2">
          {filtered.length === 0 ? (
            <p className="text-[11px] text-muted-foreground text-center py-3">No edits match your filters.</p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((h) => (
                <li key={h.id} className="rounded-md border border-border bg-muted/20 p-2 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{h.editor_name || 'Staff'}</span>
                    <span className="text-muted-foreground">{fmtDateTime(h.created_at)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-muted-foreground">
                    {Number(h.old_rent_amount) !== Number(h.new_rent_amount) && (
                      <span>Rent: {formatUGX(h.old_rent_amount || 0)} → <span className="text-foreground font-medium">{formatUGX(h.new_rent_amount || 0)}</span></span>
                    )}
                    {Number(h.old_outstanding) !== Number(h.new_outstanding) && (
                      <span>Balance: {formatUGX(h.old_outstanding || 0)} → <span className="text-foreground font-medium">{formatUGX(h.new_outstanding || 0)}</span></span>
                    )}
                    {Number(h.old_daily_repayment) !== Number(h.new_daily_repayment) && (
                      <span>Daily: {formatUGX(h.old_daily_repayment || 0)} → <span className="text-foreground font-medium">{formatUGX(h.new_daily_repayment || 0)}</span></span>
                    )}
                  </div>
                  <p className="mt-1 italic text-muted-foreground">"{h.reason}"</p>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="timeline" className="mt-2">
          {filtered.length === 0 ? (
            <p className="text-[11px] text-muted-foreground text-center py-3">No edits match your filters.</p>
          ) : (
            <div className="relative pl-5">
              <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />
              <ul className="space-y-3">
                {filtered.map((h, idx) => {
                  const date = new Date(h.created_at);
                  const dateLabel = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
                  const timeLabel = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                  const isFirst = idx === 0;
                  const rentChanged = Number(h.old_rent_amount) !== Number(h.new_rent_amount);
                  const balChanged = Number(h.old_outstanding) !== Number(h.new_outstanding);
                  const dailyChanged = Number(h.old_daily_repayment) !== Number(h.new_daily_repayment);

                  return (
                    <li key={h.id} className="relative">
                      <div className={cn(
                        "absolute -left-5 top-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center bg-background",
                        isFirst ? "border-primary" : "border-muted-foreground/30"
                      )}>
                        {isFirst ? <div className="h-1.5 w-1.5 rounded-full bg-primary" /> : <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />}
                      </div>
                      <div className="rounded-lg border border-border bg-card p-2.5 shadow-sm">
                        <div className="flex items-center gap-1.5 mb-1">
                          <User className="h-3 w-3 text-muted-foreground" />
                          <span className="text-[11px] font-semibold">{h.editor_name || 'Staff'}</span>
                          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Clock className="h-2.5 w-2.5" /> {dateLabel} · {timeLabel}
                          </span>
                        </div>
                        <div className="space-y-1">
                          {rentChanged && (
                            <div className="flex items-center gap-2 text-[11px]">
                              <Badge variant="outline" className="text-[9px] h-4 px-1">Rent</Badge>
                              <span className="text-muted-foreground line-through">{formatUGX(h.old_rent_amount || 0)}</span>
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                              <span className="font-medium text-foreground">{formatUGX(h.new_rent_amount || 0)}</span>
                            </div>
                          )}
                          {balChanged && (
                            <div className="flex items-center gap-2 text-[11px]">
                              <Badge variant="outline" className="text-[9px] h-4 px-1">Balance</Badge>
                              <span className="text-muted-foreground line-through">{formatUGX(h.old_outstanding || 0)}</span>
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                              <span className={cn("font-medium", (h.new_outstanding || 0) < (h.old_outstanding || 0) ? "text-emerald-600" : "text-foreground")}>
                                {formatUGX(h.new_outstanding || 0)}
                              </span>
                            </div>
                          )}
                          {dailyChanged && (
                            <div className="flex items-center gap-2 text-[11px]">
                              <Badge variant="outline" className="text-[9px] h-4 px-1">Daily</Badge>
                              <span className="text-muted-foreground line-through">{formatUGX(h.old_daily_repayment || 0)}</span>
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                              <span className="font-medium text-foreground">{formatUGX(h.new_daily_repayment || 0)}</span>
                            </div>
                          )}
                        </div>
                        <p className="mt-1.5 text-[10px] italic text-muted-foreground border-t border-border/50 pt-1">"{h.reason}"</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}