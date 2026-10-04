import { useEffect, useMemo, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow, format } from 'date-fns';
import { toast } from 'sonner';
import {
  Loader2,
  RefreshCw,
  Inbox,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  User as UserIcon,
  Download,
  FileText,
  Columns3,
} from 'lucide-react';
import {
  PendingBatch,
  channelLabel,
  listPendingFinOpsBatches,
  DepositChannel,
} from '@/lib/fieldDepositBatches';
import { FieldDepositVerifyDialog } from './FieldDepositVerifyDialog';
import { supabase } from '@/integrations/supabase/client';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { downloadCsv, csvTimestamp } from '@/lib/csvExport';
import { downloadAuditPdf, pdfTimestampLabel } from '@/lib/pdfAuditReport';
import { downloadXlsx } from '@/lib/xlsxExport';

/**
 * A row in the unified verification table — pending batches PLUS the most
 * recent resolved batches, so the operator can see "Verified by / Verified at"
 * directly in the queue without opening another panel.
 */
interface QueueRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  channel: DepositChannel;
  declared_total: number;
  proof_reference: string | null;
  proof_submitted_at: string | null;
  status: 'pending_finops_verification' | 'verified' | 'rejected';
  verified_by_id: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
  items_count: number;
  surplus: number;
  /** Carries the full PendingBatch payload when this row is still pending,
   *  so the verify dialog can be opened without a refetch. */
  pendingPayload: PendingBatch | null;
}

interface Props {
  /** When provided, only batches whose channel is in this set are shown. Empty/undefined = all. */
  channels?: DepositChannel[];
  /** Minimum declared total (UGX). */
  minAmount?: number;
  /** Maximum declared total (UGX). */
  maxAmount?: number;
  /** When set, only show resolved batches verified by this operator user_id.
   *  Pending batches (no verifier yet) are hidden while this is active. */
  verifierId?: string;
  /** Export-only — start of the verification window (ISO). Filters CSV rows
   *  by finops_verified_at >= this timestamp. Live queue is unaffected. */
  exportFromIso?: string;
  /** Export-only — end of the verification window (ISO), inclusive. */
  exportToIso?: string;
}

export function FieldDepositVerificationQueue({
  channels,
  minAmount,
  maxAmount,
  verifierId,
  exportFromIso,
  exportToIso,
}: Props = {}) {
  const autoRefresh = useFinOpsAutoRefresh();
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [active, setActive] = useState<PendingBatch | null>(null);

  // Single source of truth for table columns. Keeping render and export
  // driven from the same registry guarantees the CSV can never include or
  // omit a column relative to what the operator actually sees.
  type ColKey =
    | 'batch'
    | 'amount'
    | 'status'
    | 'verified_by'
    | 'verified_at';
  const COLUMNS: { key: ColKey; label: string; csvHeaders: string[]; alwaysOn?: boolean }[] = [
    { key: 'batch', label: 'Batch', csvHeaders: ['Batch ID', 'Agent ID', 'Agent name', 'Channel', 'Proof reference', 'Proof submitted at'], alwaysOn: true },
    { key: 'amount', label: 'Amount', csvHeaders: ['Declared total (UGX)'] },
    { key: 'status', label: 'Status', csvHeaders: ['Outcome', 'Rejection reason'] },
    { key: 'verified_by', label: 'Verified by', csvHeaders: ['Verified by (ID)', 'Verified by'] },
    { key: 'verified_at', label: 'Verified at', csvHeaders: ['Verified at'] },
  ];
  const [visibleCols, setVisibleCols] = useState<Record<ColKey, boolean>>({
    batch: true, amount: true, status: true, verified_by: true, verified_at: true,
  });
  const isVisible = (k: ColKey) => visibleCols[k];
  const toggleCol = (k: ColKey) => setVisibleCols((p) => ({ ...p, [k]: !p[k] }));

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      // 1. Pending batches (rich payload, used to open the verify dialog).
      const pending = await listPendingFinOpsBatches();

      // 2. Most recently resolved batches — verified or rejected — so the
      //    table can show who acted and when.
      const { data: resolved, error: resolvedErr } = await supabase
        .from('field_deposit_batches')
        .select(
          'id, agent_id, channel, declared_total, proof_reference, proof_submitted_at, status, finops_verified_by, finops_verified_at',
        )
        .in('status', ['verified', 'rejected'])
        .not('finops_verified_by', 'is', null)
        .order('finops_verified_at', { ascending: false })
        .limit(15);
      if (resolvedErr) throw resolvedErr;

      // 3. Resolve operator + agent names for resolved rows in one round-trip.
      const resolvedList = (resolved ?? []) as any[];
      const profileIds = Array.from(
        new Set(
          [
            ...resolvedList.map((r) => r.finops_verified_by).filter(Boolean),
            ...resolvedList.map((r) => r.agent_id).filter(Boolean),
          ],
        ),
      );
      const profileMap = new Map<string, { full_name: string | null }>();
      if (profileIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', profileIds);
        for (const p of (profs ?? []) as any[]) profileMap.set(p.id, p);
      }

      const pendingRows: QueueRow[] = pending.map((b) => {
        const tagged = b.items.reduce((s, i) => s + Number(i.amount || 0), 0);
        return {
          id: b.id,
          agent_id: b.agent_id,
          agent_name: b.agent_name,
          channel: b.channel,
          declared_total: Number(b.declared_total || 0),
          proof_reference: b.proof_reference,
          proof_submitted_at: b.proof_submitted_at,
          status: 'pending_finops_verification',
          verified_by_id: null,
          verified_by_name: null,
          verified_at: null,
          items_count: b.items.length,
          surplus: Math.max(0, Number(b.declared_total || 0) - tagged),
          pendingPayload: b,
        };
      });

      const resolvedRows: QueueRow[] = resolvedList.map((r) => ({
        id: r.id,
        agent_id: r.agent_id,
        agent_name: profileMap.get(r.agent_id)?.full_name ?? null,
        channel: r.channel as DepositChannel,
        declared_total: Number(r.declared_total || 0),
        proof_reference: r.proof_reference,
        proof_submitted_at: r.proof_submitted_at,
        status: r.status === 'verified' ? 'verified' : 'rejected',
        verified_by_id: r.finops_verified_by,
        verified_by_name: profileMap.get(r.finops_verified_by)?.full_name ?? null,
        verified_at: r.finops_verified_at,
        items_count: 0,
        surplus: 0,
        pendingPayload: null,
      }));

      // Pending always at the top — that's where action happens.
      setRows([...pendingRows, ...resolvedRows]);
    } catch (e: any) {
      if (!silent) toast.error(e?.message ?? 'Failed to load deposits');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const id = setInterval(() => load(true), 15000);
    return () => clearInterval(id);
  }, [load, autoRefresh]);

  // Apply hub-level filters before any totals so badges match what the
  // operator actually sees in the list.
  const visibleRows = useMemo(() => {
    return rows.filter((r) => {
      if (channels && channels.length > 0 && !channels.includes(r.channel)) return false;
      const amt = r.declared_total;
      if (typeof minAmount === 'number' && amt < minAmount) return false;
      if (typeof maxAmount === 'number' && amt > maxAmount) return false;
      if (verifierId) {
        // Pending rows have no verifier yet — hide them when filtering.
        if (!r.verified_by_id || r.verified_by_id !== verifierId) return false;
      }
      return true;
    });
  }, [rows, channels, minAmount, maxAmount, verifierId]);

  const pendingVisible = visibleRows.filter((r) => r.status === 'pending_finops_verification');
  const totalDeclared = pendingVisible.reduce((s, r) => s + r.declared_total, 0);
  const filtersActive =
    (channels && channels.length > 0) ||
    typeof minAmount === 'number' ||
    typeof maxAmount === 'number';
  const hiddenCount = rows.length - visibleRows.length;

  /**
   * Builds the export dataset (headers + row cells) from `visibleRows` plus
   * a server backfill that uses the SAME filter set. Both CSV and PDF
   * exports consume this identical payload so the two file formats can
   * never diverge on rows or columns.
   */
  const buildExportPayload = async () => {
    // Resolve agent + verifier names already cached in `visibleRows`.
    const inMemoryNameMap = new Map<string, string | null>();
    for (const r of visibleRows) {
      if (r.agent_name) inMemoryNameMap.set(r.agent_id, r.agent_name);
      if (r.verified_by_id && r.verified_by_name) inMemoryNameMap.set(r.verified_by_id, r.verified_by_name);
    }

    let q = supabase
      .from('field_deposit_batches')
      .select(
        'id, agent_id, channel, declared_total, proof_reference, proof_submitted_at, status, finops_verified_by, finops_verified_at, rejection_reason',
      )
      .in('status', ['verified', 'rejected'])
      .not('finops_verified_by', 'is', null)
      .order('finops_verified_at', { ascending: false })
      .limit(1000);
    if (channels && channels.length > 0) q = q.in('channel', channels);
    if (typeof minAmount === 'number') q = q.gte('declared_total', minAmount);
    if (typeof maxAmount === 'number') q = q.lte('declared_total', maxAmount);
    if (verifierId) q = q.eq('finops_verified_by', verifierId);
    if (exportFromIso) q = q.gte('finops_verified_at', exportFromIso);
    if (exportToIso) q = q.lte('finops_verified_at', exportToIso);
    const { data, error } = await q;
    if (error) throw error;
    const serverList = (data ?? []) as any[];
    const ids = Array.from(
      new Set([
        ...serverList.map((r) => r.finops_verified_by).filter(Boolean),
        ...serverList.map((r) => r.agent_id).filter(Boolean),
      ]),
    ).filter((id) => !inMemoryNameMap.has(id));
    const nameMap = new Map<string, string | null>();
    for (const [k, v] of inMemoryNameMap) nameMap.set(k, v);
    if (ids.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', ids);
      for (const p of (profs ?? []) as any[]) nameMap.set(p.id, p.full_name);
    }

    type ExportRow = {
      id: string; agent_id: string; agent_name: string | null;
      channel: DepositChannel; declared_total: number;
      proof_reference: string | null; proof_submitted_at: string | null;
      status: string; verified_by_id: string | null; verified_by_name: string | null;
      verified_at: string | null; rejection_reason: string | null;
    };
    const merged = new Map<string, ExportRow>();
    for (const r of visibleRows) {
      merged.set(r.id, {
        id: r.id,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        channel: r.channel,
        declared_total: r.declared_total,
        proof_reference: r.proof_reference,
        proof_submitted_at: r.proof_submitted_at,
        status: r.status === 'pending_finops_verification' ? 'pending' : r.status,
        verified_by_id: r.verified_by_id,
        verified_by_name: r.verified_by_name,
        verified_at: r.verified_at,
        rejection_reason: null,
      });
    }
    for (const r of serverList) {
      if (merged.has(r.id)) {
        const existing = merged.get(r.id)!;
        existing.rejection_reason = r.rejection_reason ?? null;
      } else {
        merged.set(r.id, {
          id: r.id,
          agent_id: r.agent_id,
          agent_name: nameMap.get(r.agent_id) ?? null,
          channel: r.channel as DepositChannel,
          declared_total: Number(r.declared_total || 0),
          proof_reference: r.proof_reference ?? null,
          proof_submitted_at: r.proof_submitted_at ?? null,
          status: r.status,
          verified_by_id: r.finops_verified_by ?? null,
          verified_by_name: r.finops_verified_by ? (nameMap.get(r.finops_verified_by) ?? null) : null,
          verified_at: r.finops_verified_at ?? null,
          rejection_reason: r.rejection_reason ?? null,
        });
      }
    }
    const exportRows = Array.from(merged.values());

    // Build headers + row cells from the visible-column registry only.
    const headers: string[] = [];
    const rowBuilders: ((r: ExportRow) => (string | number | null)[])[] = [];
    for (const c of COLUMNS) {
      if (!visibleCols[c.key]) continue;
      headers.push(...c.csvHeaders);
      if (c.key === 'batch') rowBuilders.push((r) => [
        r.id,
        r.agent_id,
        r.agent_name ?? '',
        channelLabel(r.channel),
        r.proof_reference ?? '',
        csvTimestamp(r.proof_submitted_at),
      ]);
      else if (c.key === 'amount') rowBuilders.push((r) => [r.declared_total]);
      else if (c.key === 'status') rowBuilders.push((r) => [
        r.status === 'verified' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : 'Pending',
        r.rejection_reason ?? '',
      ]);
      else if (c.key === 'verified_by') rowBuilders.push((r) => [
        r.verified_by_id ?? '',
        r.verified_by_name ?? '',
      ]);
      else if (c.key === 'verified_at') rowBuilders.push((r) => [csvTimestamp(r.verified_at)]);
    }

    const rows = exportRows.map((r) => rowBuilders.flatMap((b) => b(r)));
    return { headers, rows, count: exportRows.length };
  };

  /** Build the human-readable filter list shown atop the PDF report. */
  const describeActiveFilters = (): string[] => {
    const lines: string[] = [];
    if (channels && channels.length > 0) {
      lines.push(`Channels: ${channels.map((c) => channelLabel(c)).join(', ')}`);
    }
    if (typeof minAmount === 'number' || typeof maxAmount === 'number') {
      const min = typeof minAmount === 'number' ? formatUGX(minAmount) : '—';
      const max = typeof maxAmount === 'number' ? formatUGX(maxAmount) : '—';
      lines.push(`Amount range: ${min} → ${max}`);
    }
    if (verifierId) lines.push(`Verifier: ${verifierId.slice(0, 8)}…`);
    if (exportFromIso || exportToIso) {
      lines.push(`Verified between: ${pdfTimestampLabel(exportFromIso)} → ${pdfTimestampLabel(exportToIso)}`);
    }
    if (lines.length === 0) lines.push('No filters applied — full visible queue.');
    return lines;
  };

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const { headers, rows, count } = await buildExportPayload();
      if (count === 0) {
        toast.info('Nothing to export — no batches match the current filters.');
        return;
      }
      downloadCsv(
        `field-deposits-audit-${new Date().toISOString().slice(0, 10)}.csv`,
        headers,
        rows,
      );
      toast.success(`Exported ${count} batch${count === 1 ? '' : 'es'} to CSV.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to export audit log');
    } finally {
      setExporting(false);
    }
  };

  /**
   * PDF audit report — uses the same headers/rows as the CSV (so format
   * choice never changes the data), wrapped in a paginated landscape PDF
   * with a title block and active-filter summary for archive use.
   */
  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const { headers, rows, count } = await buildExportPayload();
      if (count === 0) {
        toast.info('Nothing to export — no batches match the current filters.');
        return;
      }
      await downloadAuditPdf(
        `field-deposits-audit-${new Date().toISOString().slice(0, 10)}.pdf`,
        headers,
        rows,
        {
          title: 'Field Deposit Verification — Audit Report',
          subtitle: 'Welile Financial Operations',
          filters: describeActiveFilters(),
          footerLabel: 'Welile FinOps · Field Deposit Audit',
        },
      );
      toast.success(`Exported ${count} batch${count === 1 ? '' : 'es'} to PDF.`);
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
        toast.info('Nothing to export — no batches match the current filters.');
        return;
      }
      await downloadXlsx(
        `field-deposits-audit-${new Date().toISOString().slice(0, 10)}.xlsx`,
        headers,
        rows,
        'Field Deposits',
      );
      toast.success(`Exported ${count} batch${count === 1 ? '' : 'es'} to XLSX.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to export audit log');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Field Deposits — Verification Queue
            </CardTitle>
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    title="Show or hide columns — also applies to CSV export"
                  >
                    <Columns3 className="h-3.5 w-3.5" />
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
                      disabled={c.alwaysOn}
                    >
                      {c.label}
                      {c.alwaysOn && (
                        <span className="ml-auto text-[10px] text-muted-foreground italic">always</span>
                      )}
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
                    className="h-8 gap-1 text-xs"
                    title="Download verified & rejected batches for audit reconciliation"
                  >
                    {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
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
                    <Download className="mr-2 h-3.5 w-3.5" />
                    CSV (spreadsheet)
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={false}
                    onCheckedChange={() => handleExportXlsx()}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <Download className="mr-2 h-3.5 w-3.5" />
                    XLSX (Excel)
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={false}
                    onCheckedChange={() => handleExportPdf()}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <FileText className="mr-2 h-3.5 w-3.5" />
                    PDF (audit report)
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => load(false)}
                disabled={refreshing}
                className="h-8"
              >
                {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="font-mono">
              {pendingVisible.length} pending
            </Badge>
            <Badge variant="secondary" className="font-mono">{formatUGX(totalDeclared)} to verify</Badge>
            {filtersActive && hiddenCount > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {hiddenCount} hidden by filter
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="py-10 flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="py-10 flex flex-col items-center text-center text-muted-foreground">
              <Inbox className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm font-medium">
                {filtersActive ? 'No batches match your filters' : 'Nothing here yet'}
              </p>
              <p className="text-xs">
                {filtersActive
                  ? `${rows.length} batch${rows.length === 1 ? '' : 'es'} hidden — clear filters to see them.`
                  : 'No field deposit batches in the queue.'}
              </p>
            </div>
          ) : (
            <ScrollArea className="max-h-[60vh]">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground sticky top-0 z-10">
                  <tr>
                    {isVisible('batch') && <th className="text-left font-medium px-2 py-2">Batch</th>}
                    {isVisible('amount') && <th className="text-right font-medium px-2 py-2">Amount</th>}
                    {isVisible('status') && <th className="text-left font-medium px-2 py-2">Status</th>}
                    {isVisible('verified_by') && <th className="text-left font-medium px-2 py-2">Verified by</th>}
                    {isVisible('verified_at') && <th className="text-left font-medium px-2 py-2 whitespace-nowrap">Verified at</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const isPending = r.status === 'pending_finops_verification';
                    return (
                      <tr
                        key={r.id}
                        onClick={() => {
                          if (r.pendingPayload) setActive(r.pendingPayload);
                        }}
                        className={
                          'border-t transition-colors ' +
                          (isPending
                            ? 'cursor-pointer hover:bg-accent/30 bg-background'
                            : 'bg-muted/10')
                        }
                      >
                        {isVisible('batch') && (
                        <td className="px-2 py-2 align-top">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium truncate max-w-[140px]">
                              {r.agent_name ?? r.agent_id.slice(0, 8)}
                            </span>
                            <Badge variant="outline" className="text-[9px] h-4 px-1">
                              {channelLabel(r.channel)}
                            </Badge>
                            {r.surplus > 0 && (
                              <Badge variant="outline" className="text-[9px] h-4 px-1 border-warning/30 text-warning">
                                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                                Surplus
                              </Badge>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {isPending && (
                              <>
                                {r.items_count} tenant{r.items_count === 1 ? '' : 's'} · proof{' '}
                                <span className="font-mono">{r.proof_reference ?? '—'}</span>
                              </>
                            )}
                            {!isPending && r.proof_reference && (
                              <>proof <span className="font-mono">{r.proof_reference}</span></>
                            )}
                          </div>
                        </td>
                        )}
                        {isVisible('amount') && (
                        <td className="px-2 py-2 align-top text-right font-mono font-semibold tabular-nums">
                          {formatUGX(r.declared_total)}
                        </td>
                        )}
                        {isVisible('status') && (
                        <td className="px-2 py-2 align-top">
                          {isPending ? (
                            <Badge variant="outline" className="text-[9px] h-4 px-1 gap-0.5">
                              <Clock className="h-2.5 w-2.5" /> Pending
                            </Badge>
                          ) : r.status === 'verified' ? (
                            <Badge className="text-[9px] h-4 px-1 gap-0.5 bg-emerald-600 hover:bg-emerald-600">
                              <CheckCircle2 className="h-2.5 w-2.5" /> Verified
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-[9px] h-4 px-1 gap-0.5">
                              <XCircle className="h-2.5 w-2.5" /> Rejected
                            </Badge>
                          )}
                        </td>
                        )}
                        {isVisible('verified_by') && (
                        <td className="px-2 py-2 align-top">
                          {r.verified_by_name ? (
                            <div className="flex items-center gap-1">
                              <UserIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                              <span className="font-medium">
                                {r.verified_by_name}
                              </span>
                            </div>
                          ) : r.verified_by_id ? (
                            <span className="text-muted-foreground font-mono">
                              {r.verified_by_id.slice(0, 8)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground italic">Awaiting</span>
                          )}
                        </td>
                        )}
                        {isVisible('verified_at') && (
                        <td
                          className="px-2 py-2 align-top text-muted-foreground tabular-nums whitespace-nowrap"
                        >
                          {r.verified_at ? (
                            <TooltipProvider delayDuration={150}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
                                    {formatDistanceToNow(new Date(r.verified_at), { addSuffix: true })}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent variant="dark" className="text-xs">
                                  <div className="flex items-center gap-1.5 font-semibold">
                                    {r.status === 'verified' ? (
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
                                    {format(new Date(r.verified_at), 'PPpp')}
                                  </div>
                                  {r.verified_by_name && (
                                    <div className="mt-0.5 opacity-75">
                                      by {r.verified_by_name}
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

      <FieldDepositVerifyDialog
        batch={active}
        open={active !== null}
        onClose={() => setActive(null)}
        onResolved={() => load(true)}
      />
    </>
  );
}