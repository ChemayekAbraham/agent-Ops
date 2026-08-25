import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { format, startOfDay, endOfDay, subDays } from 'date-fns';
import { toast } from 'sonner';
import { downloadCsv, csvTimestamp } from '@/lib/csvExport';
import {
  TENANT_CALL_STATUS_LABEL,
  useTenantCallRecords,
  type TenantCallStatus,
} from '@/hooks/useTenantCallReports';
import type { CallingListRow } from '@/hooks/useTenantCallingList';

type ReportKind = 'all' | 'pending' | 'closed' | 'missed' | 'staff' | 'comments';

const KINDS: { key: ReportKind; label: string; detail: string }[] = [
  { key: 'all', label: 'All calls', detail: 'Every call logged in the window' },
  { key: 'pending', label: 'Pending calls', detail: 'Follow-up still expected' },
  { key: 'closed', label: 'Closed calls', detail: 'Matter resolved' },
  { key: 'missed', label: 'Missed calls', detail: 'Tenant not reached' },
  { key: 'staff', label: 'Calls made per staff', detail: 'Volume by staff member' },
  { key: 'comments', label: 'Comments log', detail: 'Only calls carrying a comment' },
];

const HEADERS = [
  'Called at', 'Status', 'Comment', 'Logged by',
  'Tenant', 'Tenant phone', 'National ID', 'Village', 'District', 'Region',
  'Agent', 'Agent phone', 'Landlord', 'Landlord phone',
  'Rent (UGX)', 'Expected daily (UGX)', 'Repaid (UGX)', 'Amount owed (UGX)',
  'Missed days', 'Repayment %', 'Plan status', 'Rent request ID', 'Tenant ID',
];

/**
 * Date-ranged reports and exports for the Calling Hub. Uses the existing
 * calendar/popover date pattern and the shared `downloadCsv` helper — no new
 * export machinery.
 */
export function TenantCallReportsPanel({ rows }: { rows: CallingListRow[] }) {
  const [from, setFrom] = useState<Date | undefined>(subDays(new Date(), 30));
  const [to, setTo] = useState<Date | undefined>(new Date());
  const [busy, setBusy] = useState<ReportKind | null>(null);

  const fromISO = from ? startOfDay(from).toISOString() : null;
  const toISO = to ? endOfDay(to).toISOString() : null;
  const { data: records, isLoading } = useTenantCallRecords(fromISO, toISO);

  const byTenant = useMemo(() => {
    const m = new Map<string, CallingListRow>();
    rows.forEach(r => m.set(r.tenant_id, r));
    return m;
  }, [rows]);

  const statusOf = (r: { status: TenantCallStatus | null; outcome: string }): TenantCallStatus =>
    (r.status || (r.outcome === 'missed' ? 'missed' : 'pending')) as TenantCallStatus;

  const counts = useMemo(() => {
    const c = { all: 0, pending: 0, closed: 0, missed: 0, comments: 0 };
    (records || []).forEach(r => {
      c.all += 1;
      c[statusOf(r)] += 1;
      if (r.comment) c.comments += 1;
    });
    return c;
  }, [records]);

  const run = (kind: ReportKind) => {
    const all = records || [];
    if (!all.length) {
      toast.error('No calls recorded in this date range');
      return;
    }
    setBusy(kind);
    try {
      const label = `${from ? format(from, 'dd MMM yyyy') : 'start'} — ${to ? format(to, 'dd MMM yyyy') : 'today'}`;
      const stamp = `${from ? format(from, 'yyyyMMdd') : 'start'}-${to ? format(to, 'yyyyMMdd') : 'today'}`;

      if (kind === 'staff') {
        const agg = new Map<string, { total: number; pending: number; closed: number; missed: number; last: string }>();
        all.forEach(r => {
          const key = r.called_by || 'unknown';
          const cur = agg.get(key) || { total: 0, pending: 0, closed: 0, missed: 0, last: '' };
          cur.total += 1;
          cur[statusOf(r)] += 1;
          if (!cur.last || r.called_at > cur.last) cur.last = r.called_at;
          agg.set(key, cur);
        });
        downloadCsv(
          `tenant-calls-per-staff_${stamp}.csv`,
          ['Staff user ID', 'Calls made', 'Pending', 'Closed', 'Missed', 'Last call', 'Window'],
          [...agg.entries()].map(([id, v]) => [id, v.total, v.pending, v.closed, v.missed, csvTimestamp(v.last), label]),
        );
        toast.success(`Exported ${agg.size} staff rows`);
        return;
      }

      const filtered = all.filter(r => {
        if (kind === 'all') return true;
        if (kind === 'comments') return !!r.comment;
        return statusOf(r) === kind;
      });
      if (!filtered.length) {
        toast.error('Nothing to export for that selection');
        return;
      }

      downloadCsv(
        `tenant-calls-${kind}_${stamp}.csv`,
        HEADERS,
        filtered.map(r => {
          const t = byTenant.get(r.tenant_id);
          return [
            csvTimestamp(r.called_at),
            TENANT_CALL_STATUS_LABEL[statusOf(r)],
            r.comment || '',
            r.called_by,
            t?.tenant_name || '',
            t?.phone || '',
            t?.national_id || '',
            t?.village || '',
            t?.district || t?.city || '',
            t?.region || '',
            t?.agent_name || '',
            t?.agent_phone || '',
            t?.landlord_name || '',
            t?.landlord_phone || '',
            t?.rent_amount ?? '',
            t?.daily_repayment ?? '',
            t?.amount_repaid ?? '',
            t?.outstanding_balance ?? '',
            t?.missed_days ?? '',
            t?.repayment_pct ?? '',
            t?.status || '',
            r.rent_request_id || '',
            r.tenant_id,
          ];
        }),
      );
      toast.success(`Exported ${filtered.length} call records`);
    } finally {
      setBusy(null);
    }
  };

  const datePicker = (value: Date | undefined, onChange: (d?: Date) => void, placeholder: string) => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 justify-start text-xs">
          <CalendarIcon className="mr-1.5 h-3 w-3 text-muted-foreground" />
          {value ? format(value, 'dd MMM yyyy') : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={value} onSelect={onChange} initialFocus />
      </PopoverContent>
    </Popover>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileSpreadsheet className="h-4 w-4 text-primary" /> Calling reports &amp; exports
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {datePicker(from, setFrom, 'From')}
          <span className="text-xs text-muted-foreground">to</span>
          {datePicker(to, setTo, 'To')}
          {isLoading ? (
            <Badge variant="secondary" className="text-[10px]">Loading…</Badge>
          ) : (
            <>
              <Badge variant="secondary" className="text-[10px]">{counts.all.toLocaleString('en-US')} calls</Badge>
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-600">{counts.pending} pending</Badge>
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">{counts.closed} closed</Badge>
              <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-[10px] text-destructive">{counts.missed} missed</Badge>
            </>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {KINDS.map(k => (
            <button
              key={k.key}
              onClick={() => run(k.key)}
              disabled={busy !== null || isLoading}
              className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 disabled:opacity-60"
            >
              {busy === k.key ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              ) : (
                <Download className="h-4 w-4 shrink-0 text-primary" />
              )}
              <span className="min-w-0">
                <span className="block text-xs font-semibold [overflow-wrap:anywhere]">{k.label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{k.detail} · CSV</span>
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
