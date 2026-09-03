/**
 * Call history for the Tenant Calling Center — read-only over
 * `crm_call_sessions_feed` (the CRM Calling Centre's own feed), narrowed to
 * tenant calls. No new table, no duplicated call record.
 */
import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Download } from 'lucide-react';
import { useCallRecords } from '@/hooks/useCrmCallCentre';
import {
  OUTCOME_LABEL,
  computeKpis,
  deriveOutcome,
  formatCallStamp,
  formatTalkTime,
  type CallRecord,
} from '@/lib/callCentre';

const DAY_CHOICES = [7, 30, 90];

function toCsv(rows: CallRecord[]) {
  const head = ['Called at', 'Tenant', 'Number', 'District', 'Outcome', 'Talk time (s)', 'Officer', 'Summary'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [
      r.calledAt,
      r.calleeName,
      r.calleePhone,
      r.location ?? '',
      OUTCOME_LABEL[deriveOutcome(r)],
      r.durationSeconds ?? 0,
      r.staffName ?? '',
      r.summary ?? '',
    ]
      .map(esc)
      .join(','),
  );
  return [head.map(esc).join(','), ...body].join('\n');
}

export function TenantCallCenterHistory({ showKpis = true }: { showKpis?: boolean }) {
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const { data, isLoading } = useCallRecords(days);

  const tenantCalls = useMemo(
    () => (data ?? []).filter((r) => r.calleeRole === 'tenant'),
    [data],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tenantCalls;
    return tenantCalls.filter((r) =>
      [r.calleeName, r.location ?? '', r.staffName ?? ''].join(' ').toLowerCase().includes(q),
    );
  }, [tenantCalls, search]);

  const kpis = useMemo(() => computeKpis(tenantCalls), [tenantCalls]);

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tenant-calls-last-${days}-days.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {showKpis && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            { label: 'Calls placed', value: kpis.totalCalls },
            { label: 'Answered', value: kpis.answered },
            { label: 'Answer rate', value: `${kpis.answerRate}%` },
            { label: 'Talk time', value: formatTalkTime(kpis.totalTalkSeconds) },
          ].map((k) => (
            <Card key={k.label} className="rounded-xl border-border/60 p-3">
              <p className="text-[11px] text-muted-foreground">{k.label}</p>
              <p className="text-lg font-bold tabular-nums">{k.value}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAY_CHOICES.map((d) => (
              <SelectItem key={d} value={String(d)} className="text-xs">
                Last {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tenant, district or officer"
          className="h-8 w-full text-xs sm:max-w-xs"
        />
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={download} disabled={!rows.length}>
          <Download className="mr-1 h-3 w-3" />
          CSV
        </Button>
      </div>

      <Card className="min-w-0 overflow-x-auto rounded-2xl border-border/60 p-2 sm:p-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : !rows.length ? (
          <p className="p-6 text-center text-xs text-muted-foreground">No tenant calls in this window.</p>
        ) : (
          <table className="w-full min-w-[680px] text-xs">
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="py-1.5 pr-2 font-semibold">When</th>
                <th className="py-1.5 pr-2 font-semibold">Tenant</th>
                <th className="py-1.5 pr-2 font-semibold">Number</th>
                <th className="py-1.5 pr-2 font-semibold">Outcome</th>
                <th className="py-1.5 pr-2 font-semibold">Talk time</th>
                <th className="py-1.5 pr-2 font-semibold">Officer</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 400).map((r) => {
                const outcome = deriveOutcome(r);
                return (
                  <tr key={r.id} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-2 whitespace-nowrap text-muted-foreground">{formatCallStamp(r.calledAt)}</td>
                    <td className="py-1.5 pr-2 font-semibold">{r.calleeName}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">{r.calleePhone}</td>
                    <td className="py-1.5 pr-2">
                      <Badge
                        variant={outcome === 'answered' ? 'default' : 'outline'}
                        className="text-[10px]"
                      >
                        {OUTCOME_LABEL[outcome]}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-2 tabular-nums">{formatTalkTime(r.durationSeconds)}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{r.staffName ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
