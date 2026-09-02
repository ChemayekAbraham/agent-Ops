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
import { FileText, FileDown, RefreshCw, Archive } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

type PeriodKey = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'yearly', label: 'Yearly' },
];

interface ReportRow {
  id: string;
  code: string;
  requester: string;
  department: string;
  title: string;
  requested: number;
  approved: number;
  approvedAt: string;
  note: string;
  creditStatus: string;
  legacy: boolean;
}

function pad(n: number) { return String(n).padStart(2, '0'); }

/** Window start (inclusive) for the selected period, anchored on today. */
function periodStart(period: PeriodKey): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === 'daily') return d;
  if (period === 'weekly') {
    // ISO week: Monday start
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return d;
  }
  if (period === 'monthly') return new Date(d.getFullYear(), d.getMonth(), 1);
  if (period === 'quarterly') return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
  return new Date(d.getFullYear(), 0, 1);
}

function isoDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Bucket label for a timestamp under the selected period. */
function bucketOf(iso: string, period: PeriodKey): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  if (period === 'daily') return isoDate(d);
  if (period === 'weekly') {
    const t = new Date(Date.UTC(y, d.getMonth(), d.getDate()));
    const dayNum = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(
      ((t.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    );
    return `${t.getUTCFullYear()}-W${pad(week)}`;
  }
  if (period === 'monthly') return `${y}-${pad(d.getMonth() + 1)}`;
  if (period === 'quarterly') return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  return String(y);
}

function csvCell(v: unknown) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * READ-ONLY CFO report over employee/staff requisitions the CFO has approved.
 * The CFO approval timestamp (`staff_requisitions.cfo_decided_at`) is the sole
 * source of truth for filtering and period bucketing. Nothing here writes.
 */
export function EmployeeRequisitionReportPanel() {
  const [period, setPeriod] = useState<PeriodKey>('monthly');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('all');
  const [includeLegacy, setIncludeLegacy] = useState(false);

  const windowStart = useMemo(() => (from ? new Date(`${from}T00:00:00`) : periodStart(period)), [from, period]);
  const windowEnd = useMemo(() => (to ? new Date(`${to}T23:59:59.999`) : null), [to]);

  const { data: rows = [], isLoading, isRefetching, refetch } = useQuery({
    queryKey: ['cfo-employee-requisition-report', windowStart.toISOString(), windowEnd?.toISOString() ?? null, includeLegacy],
    queryFn: async (): Promise<ReportRow[]> => {
      let staffQ = supabase
        .from('staff_requisitions')
        .select('id, requisition_code, requester_name, department_key, title, amount, approved_amount, cfo_decided_at, cfo_note, wallet_credit_status')
        .not('cfo_decided_at', 'is', null)
        .gte('cfo_decided_at', windowStart.toISOString())
        .order('cfo_decided_at', { ascending: false })
        .limit(2000);
      if (windowEnd) staffQ = staffQ.lte('cfo_decided_at', windowEnd.toISOString());
      const { data: staff, error } = await staffQ;
      if (error) throw error;

      const out: ReportRow[] = (staff ?? []).map((r) => ({
        id: r.id,
        code: r.requisition_code ?? r.id.slice(0, 8).toUpperCase(),
        requester: r.requester_name ?? 'Unknown',
        department: r.department_key ?? '—',
        title: r.title ?? '—',
        requested: Number(r.amount) || 0,
        approved: Number(r.approved_amount ?? r.amount) || 0,
        approvedAt: r.cfo_decided_at as string,
        note: r.cfo_note ?? '',
        creditStatus: r.wallet_credit_status ?? '—',
        legacy: false,
      }));

      if (includeLegacy) {
        let legacyQ = supabase
          .from('employee_requisitions')
          .select('id, employee_name, employee_id, department, purpose, amount, approved_at, status, wallet_credit_status')
          .not('approved_at', 'is', null)
          .gte('approved_at', windowStart.toISOString())
          .order('approved_at', { ascending: false })
          .limit(2000);
        if (windowEnd) legacyQ = legacyQ.lte('approved_at', windowEnd.toISOString());
        const { data: legacy, error: legacyError } = await legacyQ;
        if (legacyError) throw legacyError;
        for (const r of legacy ?? []) {
          if (!(r.status ?? '').toLowerCase().includes('approv')) continue;
          out.push({
            id: r.id,
            code: r.employee_id ?? r.id.slice(0, 8).toUpperCase(),
            requester: r.employee_name ?? 'Unknown',
            department: r.department ?? '—',
            title: r.purpose ?? '—',
            requested: Number(r.amount) || 0,
            approved: Number(r.amount) || 0,
            approvedAt: r.approved_at as string,
            note: '',
            creditStatus: r.wallet_credit_status ?? '—',
            legacy: true,
          });
        }
      }

      return out.sort((a, b) => new Date(b.approvedAt).getTime() - new Date(a.approvedAt).getTime());
    },
    staleTime: 60_000,
  });

  const departments = useMemo(
    () => Array.from(new Set(rows.map((r) => r.department).filter((d) => d && d !== '—'))).sort(),
    [rows],
  );

  const filtered = useMemo(
    () => (department === 'all' ? rows : rows.filter((r) => r.department === department)),
    [rows, department],
  );

  const totals = useMemo(() => {
    const total = filtered.reduce((s, r) => s + r.approved, 0);
    return {
      count: filtered.length,
      total,
      average: filtered.length ? total / filtered.length : 0,
      staff: new Set(filtered.map((r) => r.requester)).size,
    };
  }, [filtered]);

  const buckets = useMemo(() => {
    const map = new Map<string, { bucket: string; count: number; total: number }>();
    for (const r of filtered) {
      const key = bucketOf(r.approvedAt, period);
      const cur = map.get(key) || { bucket: key, count: 0, total: 0 };
      cur.count += 1;
      cur.total += r.approved;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => (a.bucket < b.bucket ? 1 : -1));
  }, [filtered, period]);

  const handleExport = () => {
    if (!filtered.length) { toast.error('No approved requisitions match the selected filters'); return; }
    const header = ['Requisition', 'Requester', 'Department', 'Purpose', 'Requested (UGX)', 'Approved (UGX)', 'CFO approved at', 'CFO note', 'Wallet credit', 'Flow'];
    const lines = [header.join(',')];
    for (const r of filtered) {
      lines.push([
        r.code, r.requester, r.department, r.title, r.requested, r.approved,
        new Date(r.approvedAt).toLocaleString('en-GB'), r.note, r.creditStatus,
        r.legacy ? 'Legacy (public link)' : 'Staff requisition',
      ].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `employee-requisitions-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast.success(`Exported ${filtered.length} approved requisitions`);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Employee Requisition Report
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Every employee requisition approved by the CFO, recorded at the actual CFO
            approval date and time. Read-only — nothing here changes a requisition.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-1">
            {PERIODS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={period === p.key ? 'default' : 'outline'}
                onClick={() => { setPeriod(p.key); setFrom(''); setTo(''); }}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <div>
              <label className="text-[11px] text-muted-foreground">From</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">To</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Department</label>
              <Select value={department} onValueChange={setDepartment}>
                <SelectTrigger><SelectValue placeholder="All departments" /></SelectTrigger>
                <SelectContent className="z-[200]">
                  <SelectItem value="all">All departments</SelectItem>
                  {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <Button size="sm" onClick={handleExport} disabled={isLoading}>
                <FileDown className="h-4 w-4 mr-1" /> Export CSV
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isRefetching}>
                <RefreshCw className={`h-4 w-4 mr-1 ${isRefetching ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              Window: {isoDate(windowStart)} → {to || 'now'}
            </span>
            <Button size="sm" variant={includeLegacy ? 'secondary' : 'ghost'} onClick={() => setIncludeLegacy((v) => !v)}>
              <Archive className="h-4 w-4 mr-1" />
              {includeLegacy ? 'Hide legacy (public link)' : 'Include legacy (public link)'}
            </Button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Approved requisitions</p>
              <p className="text-lg font-bold">{totals.count.toLocaleString('en-US')}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Total approved</p>
              <p className="text-lg font-bold">{formatUGX(totals.total)}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Average approved</p>
              <p className="text-lg font-bold">{formatUGX(Math.round(totals.average))}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">Staff members</p>
              <p className="text-lg font-bold">{totals.staff.toLocaleString('en-US')}</p>
            </div>
          </div>

          {buckets.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="px-2 py-2 font-semibold">Period</th>
                    <th className="px-2 py-2 font-semibold">Approved</th>
                    <th className="px-2 py-2 font-semibold text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((b) => (
                    <tr key={b.bucket} className="border-t border-border/60">
                      <td className="px-2 py-2 font-mono whitespace-nowrap">{b.bucket}</td>
                      <td className="px-2 py-2">{b.count}</td>
                      <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{formatUGX(b.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  {['Requisition', 'Requester', 'Department', 'Purpose', 'Requested', 'Approved', 'CFO approved at', 'CFO note', 'Wallet credit'].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={9} className="px-2 py-6 text-center text-muted-foreground">Loading approved requisitions…</td></tr>
                )}
                {!isLoading && filtered.length === 0 && (
                  <tr><td colSpan={9} className="px-2 py-6 text-center text-muted-foreground">No CFO-approved requisitions in this window.</td></tr>
                )}
                {filtered.map((r) => (
                  <tr key={`${r.legacy ? 'l' : 's'}-${r.id}`} className="border-t border-border/60">
                    <td className="px-2 py-2 font-mono whitespace-nowrap">
                      {r.code}
                      {r.legacy && <Badge variant="outline" className="ml-1 text-[9px]">legacy</Badge>}
                    </td>
                    <td className="px-2 py-2 font-medium">{r.requester}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.department}</td>
                    <td className="px-2 py-2 max-w-[220px]">{r.title}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{formatUGX(r.requested)}</td>
                    <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{formatUGX(r.approved)}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{new Date(r.approvedAt).toLocaleString('en-GB')}</td>
                    <td className="px-2 py-2 max-w-[200px]">{r.note || '—'}</td>
                    <td className="px-2 py-2"><Badge variant="outline" className="text-[10px]">{r.creditStatus}</Badge></td>
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

export default EmployeeRequisitionReportPanel;
