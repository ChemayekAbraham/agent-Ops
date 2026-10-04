import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Loader2,
  RefreshCw,
  Inbox,
  History,
  CheckCircle2,
  XCircle,
  User as UserIcon,
  Download,
  FileText,
  Columns3,
  Search,
  X,
  CalendarIcon,
  Sparkles,
  Bot,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { downloadCsv, csvTimestamp } from '@/lib/csvExport';
import { downloadAuditPdf, pdfTimestampLabel } from '@/lib/pdfAuditReport';
import { downloadXlsx } from '@/lib/xlsxExport';
import { toast } from 'sonner';

/**
 * Compact audit trail of the most recent user-deposit verifications
 * (approved or rejected). Shown under the TID search so an operator can
 * confirm at a glance who acted on a deposit and when — and clearly
 * distinguish approved vs rejected outcomes via a status indicator.
 */
interface Row {
  id: string;
  amount: number;
  status: 'approved' | 'rejected';
  resolved_at: string | null;
  processed_by_id: string | null;
  processed_by_name: string | null;
  depositor_id: string | null;
  depositor_name: string | null;
  rejection_reason: string | null;
  auto_approved: boolean;
  auto_match_method: string | null;
}

interface Props {
  source: 'user';
  limit?: number;
  /** When set, only show deposits resolved by this operator user_id. */
  verifierId?: string;
  /** Export-only — start of the verification window (ISO). Filters CSV rows
   *  by approved_at/rejected_at >= this timestamp. Live table is unaffected. */
  exportFromIso?: string;
  /** Export-only — end of the verification window (ISO), inclusive. */
  exportToIso?: string;
}

export function RecentlyVerifiedList({ limit = 10, verifierId, exportFromIso, exportToIso }: Props) {
  const autoRefresh = useFinOpsAutoRefresh();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  // 'all' = both system + operator, 'auto' = system only, 'manual' = operator only.
  const [verifierFilter, setVerifierFilter] = useState<'all' | 'auto' | 'manual'>('all');

  // Single source of truth for table columns. Drives both render and CSV
  // export so the file always matches what the operator sees.
  type ColKey = 'status' | 'amount' | 'depositor' | 'verified_by' | 'verified_at';
  const COLUMNS: { key: ColKey; label: string; csvHeaders: string[] }[] = [
    { key: 'status', label: 'Status', csvHeaders: ['Outcome', 'Rejection reason'] },
    { key: 'amount', label: 'Amount', csvHeaders: ['Amount (UGX)'] },
    { key: 'depositor', label: 'Verified person', csvHeaders: ['Depositor (ID)', 'Depositor'] },
    { key: 'verified_by', label: 'Verified by', csvHeaders: ['Verified by (ID)', 'Verified by'] },
    { key: 'verified_at', label: 'Verified at', csvHeaders: ['Verified at'] },
  ];
  const VISIBLE_COLS_KEY = 'finops:recently-verified-cols';
  const [visibleCols, setVisibleCols] = useState<Record<ColKey, boolean>>(() => {
    if (typeof window === 'undefined') {
      return { status: true, amount: true, depositor: true, verified_by: true, verified_at: true };
    }
    try {
      const saved = window.localStorage.getItem(VISIBLE_COLS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<Record<ColKey, boolean>>;
        return {
          status: parsed.status ?? true,
          amount: parsed.amount ?? true,
          depositor: parsed.depositor ?? true,
          verified_by: parsed.verified_by ?? true,
          verified_at: parsed.verified_at ?? true,
        };
      }
    } catch { /* ignore corrupt storage */ }
    return { status: true, amount: true, depositor: true, verified_by: true, verified_at: true };
  });
  const isVisible = (k: ColKey) => visibleCols[k];
  const toggleCol = (k: ColKey) => {
    setVisibleCols((p) => {
      const next = { ...p, [k]: !p[k] };
      try {
        window.localStorage.setItem(VISIBLE_COLS_KEY, JSON.stringify(next));
      } catch { /* storage may be unavailable */ }
      return next;
    });
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      let q = supabase
        .from('deposit_requests')
        .select(
          'id, amount, status, approved_at, rejected_at, processed_by, user_id, rejection_reason, auto_approved',
        )
        .in('status', ['approved', 'rejected'])
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (verifierId) q = q.eq('processed_by', verifierId);
      if (dateFrom) {
        const fromIso = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), dateFrom.getDate(), 0, 0, 0).toISOString();
        q = q.gte('updated_at', fromIso);
      }
      if (dateTo) {
        const toIso = new Date(dateTo.getFullYear(), dateTo.getMonth(), dateTo.getDate(), 23, 59, 59, 999).toISOString();
        q = q.lte('updated_at', toIso);
      }
      const { data, error } = await q;
      if (error) throw error;

      const list = (data ?? []) as any[];
      const ids = Array.from(
        new Set([
          ...list.map((r) => r.processed_by).filter(Boolean),
          ...list.map((r) => r.user_id).filter(Boolean),
        ]),
      );
      const nameMap = new Map<string, string | null>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ids);
        for (const p of (profs ?? []) as any[]) nameMap.set(p.id, p.full_name);
      }

      // Look up the matcher method for any auto-approved deposit so we can
      // surface "TID" vs "amount+signals" on the badge tooltip.
      const autoIds = list.filter((r) => r.auto_approved).map((r) => r.id);
      const methodMap = new Map<string, string | null>();
      if (autoIds.length > 0) {
        const { data: gxs } = await supabase
          .from('gmail_transactions')
          .select('linked_deposit_request_id, auto_match_method')
          .in('linked_deposit_request_id', autoIds);
        for (const g of (gxs ?? []) as any[]) {
          methodMap.set(g.linked_deposit_request_id, g.auto_match_method ?? null);
        }
      }

      setRows(
        list.map((r) => ({
          id: r.id,
          amount: Number(r.amount || 0),
          status: r.status === 'approved' ? 'approved' : 'rejected',
          resolved_at: r.status === 'approved' ? r.approved_at : r.rejected_at,
          processed_by_id: r.processed_by ?? null,
          processed_by_name: r.processed_by ? nameMap.get(r.processed_by) ?? null : null,
          depositor_id: r.user_id ?? null,
          depositor_name: r.user_id ? nameMap.get(r.user_id) ?? null : null,
          rejection_reason: r.rejection_reason ?? null,
          auto_approved: Boolean(r.auto_approved),
          auto_match_method: methodMap.get(r.id) ?? null,
        })),
      );
    } catch (e) {
      // Silent — this list is auxiliary; don't disrupt the verify flow.
      console.warn('[recently-verified] load failed', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [limit, verifierId, dateFrom, dateTo]);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const id = setInterval(() => load(true), 30_000);
    return () => clearInterval(id);
  }, [load, autoRefresh]);

  /**
   * Builds the export dataset (headers + row cells) from a server query
   * mirroring the live table's filter set. Both CSV and PDF exports
   * consume this identical payload so format choice never changes data.
   */
  const buildExportPayload = async () => {
    let q = supabase
        .from('deposit_requests')
        .select(
          'id, amount, status, approved_at, rejected_at, processed_by, user_id, rejection_reason',
        )
        .in('status', ['approved', 'rejected'])
        .order('updated_at', { ascending: false })
        .limit(1000);
    if (verifierId) q = q.eq('processed_by', verifierId);
    if (dateFrom) {
      const fromIso = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), dateFrom.getDate(), 0, 0, 0).toISOString();
      q = q.gte('updated_at', fromIso);
    }
    if (dateTo) {
      const toIso = new Date(dateTo.getFullYear(), dateTo.getMonth(), dateTo.getDate(), 23, 59, 59, 999).toISOString();
      q = q.lte('updated_at', toIso);
    }
    const { data, error } = await q;
    if (error) throw error;
    const list = (data ?? []) as any[];

    const ids = Array.from(new Set([
      ...list.map((r) => r.processed_by).filter(Boolean),
      ...list.map((r) => r.user_id).filter(Boolean),
    ]));
    const nameMap = new Map<string, string | null>();
    if (ids.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', ids);
      for (const p of (profs ?? []) as any[]) nameMap.set(p.id, p.full_name);
    }

    // Build headers + row cells from the visible-column registry, with
    // an always-on Deposit ID prefix so the row can still be traced.
    const headers: string[] = ['Deposit ID'];
    const rowBuilders: ((r: any) => (string | number | null)[])[] = [(r) => [r.id]];
    for (const c of COLUMNS) {
      if (!visibleCols[c.key] && c.key !== 'depositor') continue;
      headers.push(...c.csvHeaders);
      if (c.key === 'status') rowBuilders.push((r) => [
        r.status === 'approved' ? 'Approved' : 'Rejected',
        r.rejection_reason ?? '',
      ]);
      else if (c.key === 'amount') rowBuilders.push((r) => [Number(r.amount || 0)]);
      else if (c.key === 'depositor') rowBuilders.push((r) => [
        r.user_id ?? '',
        nameMap.get(r.user_id) ?? '',
      ]);
      else if (c.key === 'verified_by') rowBuilders.push((r) => [
        r.processed_by ?? '',
        nameMap.get(r.processed_by) ?? '',
      ]);
      else if (c.key === 'verified_at') rowBuilders.push((r) => [
        csvTimestamp(r.status === 'approved' ? r.approved_at : r.rejected_at),
      ]);
    }

    const rows = list.map((r) => rowBuilders.flatMap((b) => b(r)));
    return { headers, rows, count: list.length };
  };

  const describeActiveFilters = (): string[] => {
    const lines: string[] = [];
    if (verifierId) lines.push(`Verifier: ${verifierId.slice(0, 8)}…`);
    if (exportFromIso || exportToIso) {
      lines.push(`Resolved between: ${pdfTimestampLabel(exportFromIso)} → ${pdfTimestampLabel(exportToIso)}`);
    }
    if (lines.length === 0) lines.push('No filters applied — full audit window.');
    return lines;
  };

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const { headers, rows, count } = await buildExportPayload();
      if (count === 0) {
        toast.info('Nothing to export — no deposits match the current filters.');
        return;
      }
      downloadCsv(
        `user-deposits-audit-${new Date().toISOString().slice(0, 10)}.csv`,
        headers,
        rows,
      );
      toast.success(`Exported ${count} deposit${count === 1 ? '' : 's'} to CSV.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to export audit log');
    } finally {
      setExporting(false);
    }
  };

  /**
   * PDF audit report — same data as the CSV, rendered as a paginated
   * landscape PDF with title block + active-filter summary for archive use.
   */
  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const { headers, rows, count } = await buildExportPayload();
      if (count === 0) {
        toast.info('Nothing to export — no deposits match the current filters.');
        return;
      }
      await downloadAuditPdf(
        `user-deposits-audit-${new Date().toISOString().slice(0, 10)}.pdf`,
        headers,
        rows,
        {
          title: 'User Deposit Verification — Audit Report',
          subtitle: 'Welile Financial Operations',
          filters: describeActiveFilters(),
          footerLabel: 'Welile FinOps · User Deposit Audit',
        },
      );
      toast.success(`Exported ${count} deposit${count === 1 ? '' : 's'} to PDF.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to export audit log');
    } finally {
      setExporting(false);
    }
  };

  /**
   * XLSX export — same payload as CSV/PDF, delivered as a real Excel file
   * with a frozen header and auto-sized columns for spreadsheet workflows.
   */
  const handleExportXlsx = async () => {
    setExporting(true);
    try {
      const { headers, rows, count } = await buildExportPayload();
      if (count === 0) {
        toast.info('Nothing to export — no deposits match the current filters.');
        return;
      }
      await downloadXlsx(
        `user-deposits-audit-${new Date().toISOString().slice(0, 10)}.xlsx`,
        headers,
        rows,
        'User Deposits',
      );
      toast.success(`Exported ${count} deposit${count === 1 ? '' : 's'} to XLSX.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to export audit log');
    } finally {
      setExporting(false);
    }
  };

  const searchNorm = search.trim().toLowerCase();
  const filteredRows = rows
    .filter((r) =>
      verifierFilter === 'auto'
        ? r.auto_approved
        : verifierFilter === 'manual'
          ? !r.auto_approved
          : true,
    )
    .filter((r) =>
      searchNorm
        ? (r.depositor_name?.toLowerCase() ?? '').includes(searchNorm) ||
          (r.depositor_id?.toLowerCase() ?? '').includes(searchNorm)
        : true,
    );
  const autoCount = rows.filter((r) => r.auto_approved).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            Recently verified
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => load(false)}
              disabled={refreshing || loading}
              className="h-7 gap-1 text-[11px]"
              title="Reload the list to pick up newly auto-verified deposits"
            >
              {refreshing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-[11px]"
                  title="Show or hide columns — also applies to CSV export"
                >
                  <Columns3 className="h-3 w-3" />
                  <span className="hidden sm:inline">Columns</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="text-[11px]">
                  Visible columns
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {COLUMNS.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.key}
                    checked={visibleCols[c.key]}
                    onCheckedChange={() => toggleCol(c.key)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {c.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={exporting}
                  className="h-7 gap-1 text-[11px]"
                  title="Download verified & rejected deposits for audit reconciliation"
                >
                  {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  <span className="hidden sm:inline">Export</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="text-[11px]">
                  Export format
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={false}
                  onCheckedChange={() => handleExportCsv()}
                  onSelect={(e) => e.preventDefault()}
                >
                  <Download className="mr-2 h-3 w-3" />
                  CSV (spreadsheet)
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={false}
                  onCheckedChange={() => handleExportXlsx()}
                  onSelect={(e) => e.preventDefault()}
                >
                  <Download className="mr-2 h-3 w-3" />
                  XLSX (Excel)
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={false}
                  onCheckedChange={() => handleExportPdf()}
                  onSelect={(e) => e.preventDefault()}
                >
                  <FileText className="mr-2 h-3 w-3" />
                  PDF (audit report)
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => load(false)}
              disabled={refreshing}
              className="h-7"
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 mt-2">
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search verified person…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'h-8 text-xs justify-start text-left font-normal w-[130px]',
                    !dateFrom && 'text-muted-foreground',
                  )}
                >
                  <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                  {dateFrom ? format(dateFrom, 'PP') : 'From'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateFrom}
                  onSelect={setDateFrom}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'h-8 text-xs justify-start text-left font-normal w-[130px]',
                    !dateTo && 'text-muted-foreground',
                  )}
                >
                  <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                  {dateTo ? format(dateTo, 'PP') : 'To'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateTo}
                  onSelect={setDateTo}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
            {(dateFrom || dateTo) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setDateFrom(undefined); setDateTo(undefined); }}
                className="h-8 px-2 text-xs text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
                <span className="hidden sm:inline ml-1">Clear</span>
              </Button>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Audit trail — who approved or rejected each user deposit.
        </p>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide mr-1">
            Source
          </span>
          {(['all', 'auto', 'manual'] as const).map((opt) => {
            const active = verifierFilter === opt;
            const label =
              opt === 'all'
                ? `All (${rows.length})`
                : opt === 'auto'
                  ? `Auto-verified ⚡ (${autoCount})`
                  : `By operator (${rows.length - autoCount})`;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setVerifierFilter(opt)}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted/40',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="py-6 flex justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="py-6 flex flex-col items-center text-center text-muted-foreground">
            <Inbox className="h-6 w-6 mb-1.5 opacity-50" />
            <p className="text-xs">
              {search ? 'No deposits match your search.' : 'No deposits verified yet.'}
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-[40vh]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground sticky top-0 z-10">
                <tr>
                  {isVisible('status') && <th className="text-left font-medium px-2 py-2">Status</th>}
                  {isVisible('amount') && <th className="text-right font-medium px-2 py-2">Amount</th>}
                  {isVisible('depositor') && <th className="text-left font-medium px-2 py-2">Verified person</th>}
                  {isVisible('verified_by') && <th className="text-left font-medium px-2 py-2">Verified by</th>}
                  {isVisible('verified_at') && <th className="text-left font-medium px-2 py-2 whitespace-nowrap">Verified at</th>}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const approved = r.status === 'approved';
                  return (
                    <tr key={r.id} className="border-t">
                      {isVisible('status') && (
                      <td className="px-2 py-2 align-top">
                        {approved ? (
                          <Badge className="text-[9px] h-4 px-1 gap-0.5 bg-success text-success-foreground hover:bg-success">
                            <CheckCircle2 className="h-2.5 w-2.5" /> Approved
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[9px] h-4 px-1 gap-0.5">
                            <XCircle className="h-2.5 w-2.5" /> Rejected
                          </Badge>
                        )}
                        {!approved && r.rejection_reason && (
                          <div
                            className="mt-1 text-[10px] text-muted-foreground italic line-clamp-2 max-w-[160px]"
                            title={r.rejection_reason}
                          >
                            {r.rejection_reason}
                          </div>
                        )}
                      </td>
                      )}
                      {isVisible('amount') && (
                      <td className="px-2 py-2 align-top text-right font-mono font-semibold tabular-nums">
                        {formatUGX(r.amount)}
                      </td>
                      )}
                      {isVisible('depositor') && (
                      <td className="px-2 py-2 align-top">
                        {r.depositor_name ? (
                          <div className="flex items-center gap-1">
                            <UserIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="font-medium truncate max-w-[120px]">
                              {r.depositor_name}
                            </span>
                          </div>
                        ) : r.depositor_id ? (
                          <span className="text-muted-foreground font-mono">
                            {r.depositor_id.slice(0, 8)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground italic">Unknown</span>
                        )}
                      </td>
                      )}
                      {isVisible('verified_by') && (
                      <td className="px-2 py-2 align-top">
                        {r.auto_approved ? (
                          <TooltipProvider delayDuration={150}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge className="text-[9px] h-4 px-1 gap-0.5 bg-primary/10 text-primary border border-primary/30 hover:bg-primary/10 cursor-help">
                                  <Bot className="h-2.5 w-2.5" />
                                  Auto-verified
                                  <Sparkles className="h-2.5 w-2.5" />
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent variant="dark" className="text-xs">
                                <div className="font-semibold flex items-center gap-1.5">
                                  <Bot className="h-3 w-3" /> System auto-verified
                                </div>
                                <div className="mt-0.5 opacity-90">
                                  Matched by{' '}
                                  {r.auto_match_method === 'tid'
                                    ? 'exact Transaction ID'
                                    : r.auto_match_method === 'amount_strong'
                                      ? 'amount + corroborating signals'
                                      : r.auto_match_method ?? 'email matcher'}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : r.processed_by_name ? (
                          <div className="flex items-center gap-1">
                            <UserIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="font-medium truncate max-w-[120px]">
                              {r.processed_by_name}
                            </span>
                          </div>
                        ) : r.processed_by_id ? (
                          <span className="text-muted-foreground font-mono">
                            {r.processed_by_id.slice(0, 8)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground italic">System</span>
                        )}
                      </td>
                      )}
                      {isVisible('verified_at') && (
                      <td
                        className="px-2 py-2 align-top text-muted-foreground tabular-nums whitespace-nowrap"
                      >
                        {r.resolved_at ? (
                          <TooltipProvider delayDuration={150}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
                                  {formatDistanceToNow(new Date(r.resolved_at), { addSuffix: true })}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent variant="dark" className="text-xs">
                                <div className="flex items-center gap-1.5 font-semibold">
                                  {approved ? (
                                    <>
                                      <CheckCircle2 className="h-3 w-3 text-success" />
                                      Approved
                                    </>
                                  ) : (
                                    <>
                                      <XCircle className="h-3 w-3 text-destructive" />
                                      Rejected
                                    </>
                                  )}
                                </div>
                                <div className="mt-0.5 tabular-nums opacity-90">
                                  {format(new Date(r.resolved_at), 'PPpp')}
                                </div>
                                {r.processed_by_name && (
                                  <div className="mt-0.5 opacity-75">
                                    by {r.processed_by_name}
                                  </div>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          '—'
                        )}
                      </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}