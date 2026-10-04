import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { FileText, FileDown, Printer, RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import {
  generateMerchantFloatRequisitionReportPdf,
  type RequisitionReportRow,
  type RequisitionReportSummaryRow,
} from '@/lib/merchantFloatRequisitionReportPdf';

interface RawRow {
  id: string;
  agent_id: string;
  requested_amount: number;
  approved_amount: number | null;
  reason: string | null;
  status: string;
  created_at: string;
  approved_at: string | null;
  rejection_reason: string | null;
  settlement_reference: string | null;
  agent?: { full_name: string | null; phone: string | null; district: string | null; region: string | null } | null;
  approver?: { full_name: string | null } | null;
}

const PAGE = 1000;

/**
 * READ-ONLY CFO report over the merchant float requisitions already recorded in
 * `float_requests`. It never writes, approves, or alters any requisition —
 * it only reads existing rows and renders/exports them.
 */
export function MerchantFloatRequisitionReportPanel() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('all');
  const [requester, setRequester] = useState('');
  const [department, setDepartment] = useState('');
  const [exporting, setExporting] = useState<'pdf' | 'print' | null>(null);

  const { data: rows = [], isLoading, isRefetching, refetch } = useQuery({
    queryKey: ['cfo-merchant-requisition-report'],
    queryFn: async (): Promise<RawRow[]> => {
      const all: RawRow[] = [];
      for (let page = 0; page < 50; page++) {
        const { data, error } = await supabase
          .from('float_requests')
          .select(
            'id, agent_id, requested_amount, approved_amount, reason, status, created_at, approved_at, rejection_reason, settlement_reference, ' +
            'agent:profiles!float_requests_agent_id_fkey(full_name, phone, district, region), ' +
            'approver:profiles!float_requests_approved_by_fkey(full_name)',
          )
          .order('created_at', { ascending: false })
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

  const statuses = useMemo(
    () => Array.from(new Set(rows.map((r) => r.status))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59`).getTime() : null;
    const rq = requester.trim().toLowerCase();
    const dep = department.trim().toLowerCase();
    return rows.filter((r) => {
      const ts = new Date(r.created_at).getTime();
      if (fromTs && ts < fromTs) return false;
      if (toTs && ts > toTs) return false;
      if (status !== 'all' && r.status !== status) return false;
      if (rq) {
        const hay = `${r.agent?.full_name ?? ''} ${r.agent?.phone ?? ''}`.toLowerCase();
        if (!hay.includes(rq)) return false;
      }
      if (dep) {
        const hay = `${r.agent?.district ?? ''} ${r.agent?.region ?? ''}`.toLowerCase();
        if (!hay.includes(dep)) return false;
      }
      return true;
    });
  }, [rows, from, to, status, requester, department]);

  const reportRows: RequisitionReportRow[] = useMemo(
    () => filtered.map((r) => ({
      reference: r.settlement_reference || `FR-${r.id.slice(0, 8).toUpperCase()}`,
      createdAt: r.created_at,
      requester: r.agent?.full_name || 'Unknown',
      phone: r.agent?.phone || undefined,
      department: [r.agent?.district, r.agent?.region].filter(Boolean).join(', ') || undefined,
      purpose: r.reason || undefined,
      requestedAmount: Number(r.requested_amount) || 0,
      approvedAmount: r.approved_amount != null ? Number(r.approved_amount) : null,
      status: r.status,
      approver: r.approver?.full_name || undefined,
      approvedAt: r.approved_at,
      remarks: r.rejection_reason || undefined,
    })),
    [filtered],
  );

  const summary: RequisitionReportSummaryRow[] = useMemo(() => {
    const map = new Map<string, RequisitionReportSummaryRow>();
    for (const r of reportRows) {
      const cur = map.get(r.status) || { status: r.status, count: 0, requested: 0, approved: 0 };
      cur.count += 1;
      cur.requested += r.requestedAmount;
      cur.approved += Number(r.approvedAmount) || 0;
      map.set(r.status, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [reportRows]);

  const totalRequested = reportRows.reduce((s, r) => s + r.requestedAmount, 0);
  const totalApproved = reportRows.reduce((s, r) => s + (Number(r.approvedAmount) || 0), 0);

  const buildPdf = async () => generateMerchantFloatRequisitionReportPdf(
    reportRows,
    summary,
    { from, to, status, requester, department },
  );

  const handleExport = async () => {
    if (!reportRows.length) { toast.error('No requisitions match the selected filters'); return; }
    setExporting('pdf');
    try {
      const blob = await buildPdf();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `merchant-float-requisitions-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`Report exported — ${reportRows.length} requisitions`);
    } catch (e) {
      toast.error((e as Error).message || 'Failed to export report');
    } finally {
      setExporting(null);
    }
  };

  const handlePrint = async () => {
    if (!reportRows.length) { toast.error('No requisitions match the selected filters'); return; }
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Merchant Float Requisition Report
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Read-only report of every merchant float requisition already recorded in the
            system. Filter, refresh, print or export as PDF — nothing here changes a
            requisition or its approval.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            <div>
              <label className="text-[11px] text-muted-foreground">From</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">To</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Status</label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent className="z-[200]">
                  <SelectItem value="all">All statuses</SelectItem>
                  {statuses.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Requester</label>
              <Input placeholder="Name or phone" value={requester} onChange={(e) => setRequester(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Department / area</label>
              <Input placeholder="District or region" value={department} onChange={(e) => setDepartment(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void handleExport()} disabled={!!exporting || isLoading}>
              {exporting === 'pdf' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileDown className="h-4 w-4 mr-1" />}
              Generate Requisition Report
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handlePrint()} disabled={!!exporting || isLoading}>
              {exporting === 'print' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Printer className="h-4 w-4 mr-1" />}
              Print
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isRefetching}>
              <RefreshCw className={`h-4 w-4 mr-1 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {(from || to || status !== 'all' || requester || department) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setFrom(''); setTo(''); setStatus('all'); setRequester(''); setDepartment(''); }}
              >
                Clear filters
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Requisitions</p>
              <p className="text-lg font-bold">{reportRows.length.toLocaleString('en-US')}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Total requested</p>
              <p className="text-lg font-bold">{formatUGX(totalRequested)}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Total approved</p>
              <p className="text-lg font-bold">{formatUGX(totalApproved)}</p>
            </div>
          </div>

          {summary.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {summary.map((s) => (
                <Badge key={s.status} variant="secondary" className="text-[11px]">
                  {s.status}: {s.count} · {formatUGX(s.requested)}
                </Badge>
              ))}
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  {['Reference', 'Date & time', 'Requester', 'Dept / area', 'Purpose', 'Requested', 'Approved', 'Status', 'Approver', 'Approved on', 'Remarks'].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={11} className="px-2 py-6 text-center text-muted-foreground">Loading requisitions…</td></tr>
                )}
                {!isLoading && reportRows.length === 0 && (
                  <tr><td colSpan={11} className="px-2 py-6 text-center text-muted-foreground">No requisitions match the selected filters.</td></tr>
                )}
                {reportRows.map((r) => (
                  <tr key={r.reference + String(r.createdAt)} className="border-t border-border/60">
                    <td className="px-2 py-2 font-mono whitespace-nowrap">{r.reference}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{new Date(r.createdAt as string).toLocaleString('en-GB')}</td>
                    <td className="px-2 py-2">
                      <span className="font-medium">{r.requester}</span>
                      {r.phone && <span className="block text-[10px] text-muted-foreground">{r.phone}</span>}
                    </td>
                    <td className="px-2 py-2">{r.department || '—'}</td>
                    <td className="px-2 py-2 max-w-[220px]">{r.purpose || '—'}</td>
                    <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{formatUGX(r.requestedAmount)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{r.approvedAmount != null ? formatUGX(Number(r.approvedAmount)) : '—'}</td>
                    <td className="px-2 py-2"><Badge variant="outline" className="text-[10px]">{r.status}</Badge></td>
                    <td className="px-2 py-2">{r.approver || '—'}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.approvedAt ? new Date(r.approvedAt as string).toLocaleString('en-GB') : '—'}</td>
                    <td className="px-2 py-2 max-w-[200px]">{r.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default MerchantFloatRequisitionReportPanel;
